/**
 * Vertical-application tool handlers + schemas for the Azure MCP relay.
 *
 * The deployed relay (interego-relay.livelysky-8b81abb0.eastus.azurecontainerapps.io)
 * is the cloud OAuth proxy that mobile clients (claude.ai app, ChatGPT app)
 * connect to — they can't run a local personal-bridge. To make the four
 * production-grade verticals usable from mobile, the relay exposes them
 * here alongside the protocol-level tools.
 *
 * Each tool resolves the user's pod URL the same way handlePublishContext
 * does: `${CSS_URL}${pod_name}/` — defaulting to the authenticated user's
 * pod when pod_name is omitted. user_did defaults are derived per-call.
 */

import {
  ingestTrainingContent,
  importCredential,
  recordPerformanceReview,
  recordLearningExperience,
  publishCitedResponse,
} from '../../applications/learner-performer-companion/src/pod-publisher.js';
import { loadWalletFromPod } from '../../applications/learner-performer-companion/src/pod-wallet.js';
import { groundedAnswer } from '../../applications/learner-performer-companion/src/grounded-answer.js';

import {
  defineCapability,
  recordProbe,
  recordNarrativeFragment,
  emergeSynthesis,
  recordEvolutionStep,
  refineConstraint,
  recognizeCapabilityEvolution,
} from '../../applications/agent-development-practice/src/pod-publisher.js';
import { loadProbeCycle } from '../../applications/agent-development-practice/src/pod-loader.js';

import {
  ingestStatementFromLrs,
  ingestStatementBatchFromLrs,
  projectDescriptorToLrs,
} from '../../applications/lrs-adapter/src/pod-publisher.js';
import { LrsClient } from '../../applications/lrs-adapter/src/lrs-client.js';

import {
  authorTool,
  attestTool,
  promoteTool,
  bundleTeachingPackage,
  recordCrossAgentAudit,
} from '../../applications/agent-collective/src/pod-publisher.js';

import type { IRI } from '@interego/core';

// ── Auth context resolution ───────────────────────────────────────────

type ToolArgs = Record<string, unknown>;

interface VerticalContext {
  podUrl: string;
  userDid: IRI;
}

function resolveContext(args: ToolArgs, cssUrl: string): VerticalContext {
  const podName = (args.pod_name as string | undefined) ?? 'default';
  // Allow per-call podUrl override (for tests / multi-pod scenarios)
  const podUrl = (args.pod_url as string | undefined) ?? `${cssUrl}${podName}/`;
  const userDid = ((args.user_did as string | undefined)
                ?? `did:web:${podName}.example`) as IRI;
  return { podUrl, userDid };
}

// ── Tool registration ────────────────────────────────────────────────

export interface VerticalTool {
  description: string;
  handler: (args: ToolArgs) => Promise<string>;
}

export interface VerticalToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Build the vertical-tools record. The relay calls this once with its
 * CSS_URL config and merges into its main TOOLS object.
 */
export function verticalTools(cssUrl: string): {
  tools: Record<string, VerticalTool>;
  schemas: VerticalToolSchema[];
} {
  const tools: Record<string, VerticalTool> = {
    // ── lpc.* — Learner / Performer Companion ─────────────────────
    'lpc.ingest_training_content': {
      description: 'Ingest a SCORM 1.2 / SCORM 2004 / cmi5 zip package into the user\'s pod (lpc:TrainingContent + lpc:LearningObjective + content-addressed PGSL atoms).',
      handler: async (args) => {
        const { podUrl, userDid } = resolveContext(args, cssUrl);
        const zipB64 = String(args.zip_base64);
        const auth = String(args.authoritative_source) as IRI;
        const r = await ingestTrainingContent(Buffer.from(zipB64, 'base64'), auth, { podUrl, userDid });
        return JSON.stringify(r);
      },
    },
    'lpc.import_credential': {
      description: 'Verify a W3C VC (vc-jwt or DataIntegrityProof JSON-LD) and publish as lpc:Credential. Verification failures throw — bad VCs never land in the pod.',
      handler: async (args) => {
        const { podUrl, userDid } = resolveContext(args, cssUrl);
        const forContent = args.for_content as IRI | undefined;
        if (typeof args.vc_jwt === 'string') {
          const r = await importCredential(args.vc_jwt, { podUrl, userDid }, forContent);
          return JSON.stringify(r);
        }
        if (args.vc_jsonld && typeof args.vc_jsonld === 'object') {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const r = await importCredential(args.vc_jsonld as any, { podUrl, userDid }, forContent);
          return JSON.stringify(r);
        }
        throw new Error('Provide either vc_jwt (string) or vc_jsonld (object)');
      },
    },
    'lpc.record_performance_review': {
      description: 'Publish a performance review with cg:ProvenanceFacet attributing it to the manager (NOT the user). Stays in user\'s pod portably.',
      handler: async (args) => {
        const { podUrl, userDid } = resolveContext(args, cssUrl);
        const r = await recordPerformanceReview({
          content: String(args.content),
          managerDid: String(args.manager_did) as IRI,
          signature: String(args.signature),
          recordedAt: String(args.recorded_at),
          flagsCapability: args.flags_capability as IRI | undefined,
        }, { podUrl, userDid });
        return JSON.stringify(r);
      },
    },
    'lpc.record_learning_experience': {
      description: 'Ingest an xAPI Statement as an lpc:LearningExperience descriptor with cross-links to training content and credential earned.',
      handler: async (args) => {
        const { podUrl, userDid } = resolveContext(args, cssUrl);
        const r = await recordLearningExperience({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          statement: args.statement as any,
          forContent: String(args.for_content) as IRI,
          earnedCredential: args.earned_credential as IRI | undefined,
          lrsEndpoint: args.lrs_endpoint as IRI | undefined,
        }, { podUrl, userDid });
        return JSON.stringify(r);
      },
    },
    'lpc.grounded_answer': {
      description: 'Answer a natural-language question by retrieving from the user\'s pod with verbatim citation. Returns null when nothing in the wallet grounds the question — honest no-data, no confabulation. Persists an lpc:CitedResponse audit record.',
      handler: async (args) => {
        const { podUrl, userDid } = resolveContext(args, cssUrl);
        const question = String(args.question);
        const persistResponse = args.persist_response !== false;
        const assistantDid = ((args.assistant_did as string | undefined) ?? 'did:web:azure-relay-assistant.local') as IRI;

        const wallet = await loadWalletFromPod({ podUrl, userDid });
        const answer = groundedAnswer(question, wallet);
        if (!answer) {
          return JSON.stringify({
            ok: true, answer: null, reason: 'no-data',
            walletSummary: {
              trainingContent: wallet.trainingContent.length,
              credentials: wallet.credentials.length,
              performanceRecords: wallet.performanceRecords.length,
              learningExperiences: wallet.learningExperiences.length,
            },
          });
        }
        let auditRecord;
        if (persistResponse) {
          auditRecord = await publishCitedResponse({ answer, assistantDid }, { podUrl, userDid });
        }
        return JSON.stringify({ ok: true, answer, auditRecord });
      },
    },
    'lpc.list_wallet': {
      description: 'Summarize what\'s in the user\'s pod-backed wallet: training content, credentials, performance records, learning experiences.',
      handler: async (args) => {
        const { podUrl, userDid } = resolveContext(args, cssUrl);
        const wallet = await loadWalletFromPod({ podUrl, userDid });
        return JSON.stringify({
          userDid: wallet.userDid,
          trainingContent: wallet.trainingContent.map(tc => ({ iri: tc.iri, name: tc.name, atomCount: tc.atoms.length })),
          credentials: wallet.credentials.map(c => ({ iri: c.iri, achievementName: c.achievementName, issuer: c.issuer, issuedAt: c.issuedAt })),
          performanceRecords: wallet.performanceRecords.map(r => ({ iri: r.iri, attributedTo: r.attributedTo, recordedAt: r.recordedAt })),
          learningExperiences: wallet.learningExperiences.map(le => ({ iri: le.iri, forContent: le.forContent, earnedCredential: le.earnedCredential, completedAt: le.completedAt })),
        });
      },
    },

    // ── adp.* — Agent Development Practice ────────────────────────
    'adp.define_capability': {
      description: 'Declare a capability SPACE (not target) with rubric criteria + Cynefin domain. Publishes adp:Capability + adp:RubricCriterion.',
      handler: async (args) => {
        const ctx = resolveContext(args, cssUrl);
        const r = await defineCapability({
          name: String(args.name),
          cynefinDomain: args.cynefin_domain as 'Clear' | 'Complicated' | 'Complex' | 'Chaotic' | 'Confused',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          rubricCriteria: args.rubric_criteria as any,
          description: args.description as string | undefined,
        }, { podUrl: ctx.podUrl, operatorDid: ctx.userDid });
        return JSON.stringify(r);
      },
    },
    'adp.record_probe': {
      description: 'Record a safe-to-fail probe. Always Hypothetical. REQUIRES amplification + dampening triggers up-front (prevents retconning).',
      handler: async (args) => {
        const ctx = resolveContext(args, cssUrl);
        const r = await recordProbe({
          capabilityIri: String(args.capability_iri) as IRI,
          variant: String(args.variant),
          hypothesis: String(args.hypothesis),
          amplificationTrigger: String(args.amplification_trigger),
          dampeningTrigger: String(args.dampening_trigger),
          timeBoundUntil: args.time_bound_until as string | undefined,
        }, { podUrl: ctx.podUrl, operatorDid: ctx.userDid });
        return JSON.stringify(r);
      },
    },
    'adp.record_narrative_fragment': {
      description: 'Record a narrative observation against a probe. Always Hypothetical. Carries situation signifiers + emergent signifier.',
      handler: async (args) => {
        const ctx = resolveContext(args, cssUrl);
        const r = await recordNarrativeFragment({
          probeIri: String(args.probe_iri) as IRI,
          contextSignifiers: args.context_signifiers as string[],
          response: String(args.response),
          emergentSignifier: String(args.emergent_signifier),
        }, { podUrl: ctx.podUrl, operatorDid: ctx.userDid });
        return JSON.stringify(r);
      },
    },
    'adp.emerge_synthesis': {
      description: 'Compose narrative fragments into a synthesis. Always Hypothetical. REQUIRES ≥2 coherent narratives — silent-collapse prevention.',
      handler: async (args) => {
        const ctx = resolveContext(args, cssUrl);
        const r = await emergeSynthesis({
          probeIri: String(args.probe_iri) as IRI,
          fragmentIris: (args.fragment_iris as string[]).map(s => s as IRI),
          emergentPattern: String(args.emergent_pattern),
          coherentNarratives: args.coherent_narratives as string[],
        }, { podUrl: ctx.podUrl, operatorDid: ctx.userDid });
        return JSON.stringify(r);
      },
    },
    'adp.record_evolution_step': {
      description: 'Operator amplify/dampen decision. Asserted but REQUIRES explicit_decision_not_made — counter-cultural; forces writing down what is NOT being claimed.',
      handler: async (args) => {
        const ctx = resolveContext(args, cssUrl);
        const r = await recordEvolutionStep({
          synthesisIri: String(args.synthesis_iri) as IRI,
          amplifyProbeIris: ((args.amplify_probe_iris as string[] | undefined) ?? []).map(s => s as IRI),
          dampenProbeIris: ((args.dampen_probe_iris as string[] | undefined) ?? []).map(s => s as IRI),
          explicitDecisionNotMade: String(args.explicit_decision_not_made),
          nextRevisitAt: args.next_revisit_at as string | undefined,
        }, { podUrl: ctx.podUrl, operatorDid: ctx.userDid });
        return JSON.stringify(r);
      },
    },
    'adp.refine_constraint': {
      description: 'Refine a constraint emerged from synthesis cycles. Boundary + exits + emergedFrom required.',
      handler: async (args) => {
        const ctx = resolveContext(args, cssUrl);
        const r = await refineConstraint({
          capabilityIri: String(args.capability_iri) as IRI,
          emergedFromSynthesisIris: (args.emerged_from_synthesis_iris as string[]).map(s => s as IRI),
          boundary: String(args.boundary),
          exitsConstraint: String(args.exits_constraint),
          supersedes: args.supersedes as IRI | undefined,
        }, { podUrl: ctx.podUrl, operatorDid: ctx.userDid });
        return JSON.stringify(r);
      },
    },
    'adp.recognize_capability_evolution': {
      description: 'Record a passport:LifeEvent biographical record. REQUIRES explicit_decision_not_made — humility-forward clauses travel across deployments.',
      handler: async (args) => {
        const ctx = resolveContext(args, cssUrl);
        const r = await recognizeCapabilityEvolution({
          capabilityIri: String(args.capability_iri) as IRI,
          evolutionType: args.evolution_type as 'EmergentRecognition' | 'ConstraintRefinement' | 'VariantAmplified' | 'VariantDampened',
          emergedFromIris: ((args.emerged_from_iris as string[] | undefined) ?? []).map(s => s as IRI),
          olkeStage: args.olke_stage as 'Tacit' | 'Articulate' | 'Collective' | 'Institutional',
          explicitDecisionNotMade: String(args.explicit_decision_not_made),
        }, { podUrl: ctx.podUrl, operatorDid: ctx.userDid });
        return JSON.stringify(r);
      },
    },
    'adp.list_cycle': {
      description: 'Load the operator\'s probe cycle state from the pod.',
      handler: async (args) => {
        const ctx = resolveContext(args, cssUrl);
        const r = await loadProbeCycle({ podUrl: ctx.podUrl, operatorDid: ctx.userDid });
        return JSON.stringify(r);
      },
    },

    // ── lrs.* — LRS Adapter ───────────────────────────────────────
    'lrs.ingest_statement': {
      description: 'Fetch a single xAPI Statement from an LRS by ID and publish as cg:ContextDescriptor in the user\'s pod. Auto-negotiates xAPI version.',
      handler: async (args) => {
        const ctx = resolveContext(args, cssUrl);
        const r = await ingestStatementFromLrs(
          { endpoint: String(args.lrs_endpoint), auth: { username: String(args.lrs_username), password: String(args.lrs_password) }, preferredVersion: (args.lrs_preferred_version as '2.0.0' | '1.0.3' | undefined) ?? '2.0.0' },
          String(args.statement_id),
          { podUrl: ctx.podUrl, userDid: ctx.userDid },
        );
        return JSON.stringify(r);
      },
    },
    'lrs.ingest_statement_batch': {
      description: 'Fetch a batch of xAPI Statements from an LRS by filter and publish each as cg:ContextDescriptor in the user\'s pod.',
      handler: async (args) => {
        const ctx = resolveContext(args, cssUrl);
        const r = await ingestStatementBatchFromLrs(
          { endpoint: String(args.lrs_endpoint), auth: { username: String(args.lrs_username), password: String(args.lrs_password) }, preferredVersion: (args.lrs_preferred_version as '2.0.0' | '1.0.3' | undefined) ?? '2.0.0' },
          {
            verb: args.verb as string | undefined,
            activity: args.activity as string | undefined,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            agent: args.agent as any,
            since: args.since as string | undefined,
            until: args.until as string | undefined,
            limit: args.limit as number | undefined,
          },
          { podUrl: ctx.podUrl, userDid: ctx.userDid },
        );
        return JSON.stringify(r);
      },
    },
    'lrs.project_descriptor': {
      description: 'Read an Asserted descriptor from the pod and project to xAPI Statement, POST to the LRS. Counterfactual ALWAYS skipped; Hypothetical skipped without opt-in; multi-narrative lossy with audit-loud lossNote rows.',
      handler: async (args) => {
        const ctx = resolveContext(args, cssUrl);
        const r = await projectDescriptorToLrs(
          { endpoint: String(args.lrs_endpoint), auth: { username: String(args.lrs_username), password: String(args.lrs_password) }, preferredVersion: (args.lrs_preferred_version as '2.0.0' | '1.0.3' | undefined) ?? '2.0.0' },
          {
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
          },
          { podUrl: ctx.podUrl, userDid: ctx.userDid },
        );
        return JSON.stringify(r);
      },
    },
    'lrs.lrs_about': {
      description: 'Probe an LRS\'s /xapi/about endpoint to discover supported xAPI versions.',
      handler: async (args) => {
        const client = new LrsClient({
          endpoint: String(args.lrs_endpoint),
          auth: { username: String(args.lrs_username), password: String(args.lrs_password) },
          preferredVersion: (args.lrs_preferred_version as '2.0.0' | '1.0.3' | undefined) ?? '2.0.0',
        });
        const v = await client.negotiateVersion();
        return JSON.stringify({ negotiatedVersion: v, endpoint: String(args.lrs_endpoint) });
      },
    },

    // ── ac.* — Agent Collective ───────────────────────────────────
    'ac.author_tool': {
      description: 'Author a new agent tool. Published Hypothetical. Source code stored as content-addressed pgsl:Atom.',
      handler: async (args) => {
        const ctx = resolveContext(args, cssUrl);
        const r = await authorTool({
          toolName: String(args.tool_name),
          sourceCode: String(args.source_code),
          affordanceAction: String(args.affordance_action),
          affordanceDescription: args.affordance_description as string | undefined,
        }, { podUrl: ctx.podUrl, authoringAgentDid: ctx.userDid });
        return JSON.stringify(r);
      },
    },
    'ac.attest_tool': {
      description: 'Record an amta:Attestation against a tool. Self / Peer × axis (correctness/efficiency/safety/generality).',
      handler: async (args) => {
        const ctx = resolveContext(args, cssUrl);
        const r = await attestTool({
          toolIri: String(args.tool_iri) as IRI,
          axis: args.axis as 'correctness' | 'efficiency' | 'safety' | 'generality',
          rating: Number(args.rating),
          direction: args.direction as 'Self' | 'Peer',
          executionEvidence: args.execution_evidence as IRI | undefined,
        }, { podUrl: ctx.podUrl, authoringAgentDid: ctx.userDid });
        return JSON.stringify(r);
      },
    },
    'ac.promote_tool': {
      description: 'Promote Hypothetical tool to Asserted. REFUSES below threshold (default 5+ self + 2+ peer + 2+ axes).',
      handler: async (args) => {
        const ctx = resolveContext(args, cssUrl);
        const r = await promoteTool({
          toolIri: String(args.tool_iri) as IRI,
          selfAttestations: Number(args.self_attestations),
          peerAttestations: Number(args.peer_attestations),
          axesCovered: args.axes_covered as string[],
          thresholdSelf: args.threshold_self as number | undefined,
          thresholdPeer: args.threshold_peer as number | undefined,
          thresholdAxes: args.threshold_axes as number | undefined,
        }, { podUrl: ctx.podUrl, authoringAgentDid: ctx.userDid });
        return JSON.stringify(r);
      },
    },
    'ac.bundle_teaching_package': {
      description: 'Bundle artifact + practice (narratives + synthesis + constraint + capability evolution) into ac:TeachingPackage. REFUSES without narrative fragments.',
      handler: async (args) => {
        const ctx = resolveContext(args, cssUrl);
        const r = await bundleTeachingPackage({
          toolIri: String(args.tool_iri) as IRI,
          narrativeFragmentIris: (args.narrative_fragment_iris as string[]).map(s => s as IRI),
          synthesisIri: String(args.synthesis_iri) as IRI,
          constraintIri: args.constraint_iri as IRI | undefined,
          capabilityEvolutionIri: args.capability_evolution_iri as IRI | undefined,
          olkeStage: args.olke_stage as 'Tacit' | 'Articulate' | 'Collective' | 'Institutional',
        }, { podUrl: ctx.podUrl, authoringAgentDid: ctx.userDid });
        return JSON.stringify(r);
      },
    },
    'ac.record_cross_agent_audit': {
      description: 'Record an ac:CrossAgentAuditEntry in the human owner\'s pod for a chime-in / response / check-in exchange.',
      handler: async (args) => {
        const ctx = resolveContext(args, cssUrl);
        const r = await recordCrossAgentAudit({
          exchangeIri: String(args.exchange_iri) as IRI,
          auditedAgentDid: String(args.audited_agent_did) as IRI,
          direction: args.direction as 'Inbound' | 'Outbound',
          humanOwnerDid: String(args.human_owner_did) as IRI,
        }, { podUrl: ctx.podUrl, authoringAgentDid: ctx.userDid });
        return JSON.stringify(r);
      },
    },
  };

  // Schemas — minimal but complete enough that an LLM picks valid args.
  // Keeping property descriptions concise; full reference in
  // applications/<vertical>/README.md.
  const podArgs = {
    pod_name: { type: 'string', description: 'Pod name (default: authenticated user\'s pod).' },
    pod_url: { type: 'string', description: 'Full pod URL (overrides pod_name).' },
    user_did: { type: 'string', description: 'User DID (default: derived from pod_name).' },
  };

  const schemas: VerticalToolSchema[] = [
    {
      name: 'lpc.ingest_training_content',
      description: tools['lpc.ingest_training_content'].description,
      inputSchema: { type: 'object', required: ['zip_base64', 'authoritative_source'], properties: { zip_base64: { type: 'string' }, authoritative_source: { type: 'string' }, ...podArgs } },
    },
    {
      name: 'lpc.import_credential',
      description: tools['lpc.import_credential'].description,
      inputSchema: { type: 'object', properties: { vc_jwt: { type: 'string' }, vc_jsonld: { type: 'object' }, for_content: { type: 'string' }, ...podArgs } },
    },
    {
      name: 'lpc.record_performance_review',
      description: tools['lpc.record_performance_review'].description,
      inputSchema: { type: 'object', required: ['content', 'manager_did', 'signature', 'recorded_at'], properties: { content: { type: 'string' }, manager_did: { type: 'string' }, signature: { type: 'string' }, recorded_at: { type: 'string' }, flags_capability: { type: 'string' }, ...podArgs } },
    },
    {
      name: 'lpc.record_learning_experience',
      description: tools['lpc.record_learning_experience'].description,
      inputSchema: { type: 'object', required: ['statement', 'for_content'], properties: { statement: { type: 'object' }, for_content: { type: 'string' }, earned_credential: { type: 'string' }, lrs_endpoint: { type: 'string' }, ...podArgs } },
    },
    {
      name: 'lpc.grounded_answer',
      description: tools['lpc.grounded_answer'].description,
      inputSchema: { type: 'object', required: ['question'], properties: { question: { type: 'string' }, persist_response: { type: 'boolean' }, assistant_did: { type: 'string' }, ...podArgs } },
    },
    {
      name: 'lpc.list_wallet',
      description: tools['lpc.list_wallet'].description,
      inputSchema: { type: 'object', properties: podArgs },
    },
    {
      name: 'adp.define_capability',
      description: tools['adp.define_capability'].description,
      inputSchema: { type: 'object', required: ['name', 'cynefin_domain', 'rubric_criteria'], properties: { name: { type: 'string' }, cynefin_domain: { type: 'string', enum: ['Clear', 'Complicated', 'Complex', 'Chaotic', 'Confused'] }, rubric_criteria: { type: 'array' }, description: { type: 'string' }, ...podArgs } },
    },
    {
      name: 'adp.record_probe',
      description: tools['adp.record_probe'].description,
      inputSchema: { type: 'object', required: ['capability_iri', 'variant', 'hypothesis', 'amplification_trigger', 'dampening_trigger'], properties: { capability_iri: { type: 'string' }, variant: { type: 'string' }, hypothesis: { type: 'string' }, amplification_trigger: { type: 'string' }, dampening_trigger: { type: 'string' }, time_bound_until: { type: 'string' }, ...podArgs } },
    },
    {
      name: 'adp.record_narrative_fragment',
      description: tools['adp.record_narrative_fragment'].description,
      inputSchema: { type: 'object', required: ['probe_iri', 'context_signifiers', 'response', 'emergent_signifier'], properties: { probe_iri: { type: 'string' }, context_signifiers: { type: 'array', items: { type: 'string' } }, response: { type: 'string' }, emergent_signifier: { type: 'string' }, ...podArgs } },
    },
    {
      name: 'adp.emerge_synthesis',
      description: tools['adp.emerge_synthesis'].description,
      inputSchema: { type: 'object', required: ['probe_iri', 'fragment_iris', 'emergent_pattern', 'coherent_narratives'], properties: { probe_iri: { type: 'string' }, fragment_iris: { type: 'array', items: { type: 'string' } }, emergent_pattern: { type: 'string' }, coherent_narratives: { type: 'array', items: { type: 'string' }, minItems: 2 }, ...podArgs } },
    },
    {
      name: 'adp.record_evolution_step',
      description: tools['adp.record_evolution_step'].description,
      inputSchema: { type: 'object', required: ['synthesis_iri', 'explicit_decision_not_made'], properties: { synthesis_iri: { type: 'string' }, amplify_probe_iris: { type: 'array', items: { type: 'string' } }, dampen_probe_iris: { type: 'array', items: { type: 'string' } }, explicit_decision_not_made: { type: 'string' }, next_revisit_at: { type: 'string' }, ...podArgs } },
    },
    {
      name: 'adp.refine_constraint',
      description: tools['adp.refine_constraint'].description,
      inputSchema: { type: 'object', required: ['capability_iri', 'emerged_from_synthesis_iris', 'boundary', 'exits_constraint'], properties: { capability_iri: { type: 'string' }, emerged_from_synthesis_iris: { type: 'array', items: { type: 'string' }, minItems: 1 }, boundary: { type: 'string' }, exits_constraint: { type: 'string' }, supersedes: { type: 'string' }, ...podArgs } },
    },
    {
      name: 'adp.recognize_capability_evolution',
      description: tools['adp.recognize_capability_evolution'].description,
      inputSchema: { type: 'object', required: ['capability_iri', 'evolution_type', 'olke_stage', 'explicit_decision_not_made'], properties: { capability_iri: { type: 'string' }, evolution_type: { type: 'string', enum: ['EmergentRecognition', 'ConstraintRefinement', 'VariantAmplified', 'VariantDampened'] }, emerged_from_iris: { type: 'array', items: { type: 'string' } }, olke_stage: { type: 'string', enum: ['Tacit', 'Articulate', 'Collective', 'Institutional'] }, explicit_decision_not_made: { type: 'string' }, ...podArgs } },
    },
    {
      name: 'adp.list_cycle',
      description: tools['adp.list_cycle'].description,
      inputSchema: { type: 'object', properties: podArgs },
    },
    {
      name: 'lrs.ingest_statement',
      description: tools['lrs.ingest_statement'].description,
      inputSchema: { type: 'object', required: ['statement_id', 'lrs_endpoint', 'lrs_username', 'lrs_password'], properties: { statement_id: { type: 'string' }, lrs_endpoint: { type: 'string' }, lrs_username: { type: 'string' }, lrs_password: { type: 'string' }, lrs_preferred_version: { type: 'string', enum: ['2.0.0', '1.0.3'] }, ...podArgs } },
    },
    {
      name: 'lrs.ingest_statement_batch',
      description: tools['lrs.ingest_statement_batch'].description,
      inputSchema: { type: 'object', required: ['lrs_endpoint', 'lrs_username', 'lrs_password'], properties: { verb: { type: 'string' }, activity: { type: 'string' }, agent: { type: 'object' }, since: { type: 'string' }, until: { type: 'string' }, limit: { type: 'number' }, lrs_endpoint: { type: 'string' }, lrs_username: { type: 'string' }, lrs_password: { type: 'string' }, lrs_preferred_version: { type: 'string' }, ...podArgs } },
    },
    {
      name: 'lrs.project_descriptor',
      description: tools['lrs.project_descriptor'].description,
      inputSchema: { type: 'object', required: ['descriptor_iri', 'actor', 'verb_id', 'object_id', 'lrs_endpoint', 'lrs_username', 'lrs_password'], properties: { descriptor_iri: { type: 'string' }, actor: { type: 'object' }, verb_id: { type: 'string' }, object_id: { type: 'string' }, verb_display: { type: 'string' }, object_name: { type: 'string' }, modal_status: { type: 'string', enum: ['Asserted', 'Hypothetical', 'Counterfactual'] }, allow_hypothetical: { type: 'boolean' }, coherent_narratives: { type: 'array', items: { type: 'string' } }, lrs_endpoint: { type: 'string' }, lrs_username: { type: 'string' }, lrs_password: { type: 'string' }, lrs_preferred_version: { type: 'string' }, ...podArgs } },
    },
    {
      name: 'lrs.lrs_about',
      description: tools['lrs.lrs_about'].description,
      inputSchema: { type: 'object', required: ['lrs_endpoint', 'lrs_username', 'lrs_password'], properties: { lrs_endpoint: { type: 'string' }, lrs_username: { type: 'string' }, lrs_password: { type: 'string' }, lrs_preferred_version: { type: 'string' } } },
    },
    {
      name: 'ac.author_tool',
      description: tools['ac.author_tool'].description,
      inputSchema: { type: 'object', required: ['tool_name', 'source_code', 'affordance_action'], properties: { tool_name: { type: 'string' }, source_code: { type: 'string' }, affordance_action: { type: 'string' }, affordance_description: { type: 'string' }, ...podArgs } },
    },
    {
      name: 'ac.attest_tool',
      description: tools['ac.attest_tool'].description,
      inputSchema: { type: 'object', required: ['tool_iri', 'axis', 'rating', 'direction'], properties: { tool_iri: { type: 'string' }, axis: { type: 'string', enum: ['correctness', 'efficiency', 'safety', 'generality'] }, rating: { type: 'number', minimum: 0, maximum: 1 }, direction: { type: 'string', enum: ['Self', 'Peer'] }, execution_evidence: { type: 'string' }, ...podArgs } },
    },
    {
      name: 'ac.promote_tool',
      description: tools['ac.promote_tool'].description,
      inputSchema: { type: 'object', required: ['tool_iri', 'self_attestations', 'peer_attestations', 'axes_covered'], properties: { tool_iri: { type: 'string' }, self_attestations: { type: 'number' }, peer_attestations: { type: 'number' }, axes_covered: { type: 'array', items: { type: 'string' } }, threshold_self: { type: 'number' }, threshold_peer: { type: 'number' }, threshold_axes: { type: 'number' }, ...podArgs } },
    },
    {
      name: 'ac.bundle_teaching_package',
      description: tools['ac.bundle_teaching_package'].description,
      inputSchema: { type: 'object', required: ['tool_iri', 'narrative_fragment_iris', 'synthesis_iri', 'olke_stage'], properties: { tool_iri: { type: 'string' }, narrative_fragment_iris: { type: 'array', items: { type: 'string' }, minItems: 1 }, synthesis_iri: { type: 'string' }, constraint_iri: { type: 'string' }, capability_evolution_iri: { type: 'string' }, olke_stage: { type: 'string' }, ...podArgs } },
    },
    {
      name: 'ac.record_cross_agent_audit',
      description: tools['ac.record_cross_agent_audit'].description,
      inputSchema: { type: 'object', required: ['exchange_iri', 'audited_agent_did', 'direction', 'human_owner_did'], properties: { exchange_iri: { type: 'string' }, audited_agent_did: { type: 'string' }, direction: { type: 'string', enum: ['Inbound', 'Outbound'] }, human_owner_did: { type: 'string' }, ...podArgs } },
    },
  ];

  return { tools, schemas };
}
