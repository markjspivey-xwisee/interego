/**
 * Bridge-handler → xAPI emission instrumentation.
 *
 * Every Foxxi affordance call produces an xAPI statement that lands in
 * Foxxi-as-LRS's statement store. The handler keeps emitting substrate
 * context-descriptors (existing path) AND additionally emits an xAPI
 * envelope so any external LRS / Caliper consumer / partner-eng SDK
 * gets the same activity stream as the substrate-side view.
 *
 * Per-handler mapping picks the most accurate Foxxi-Profile verb when
 * one applies (e.g. ask_course_question_agentic → foxxi:asked); falls
 * back to the generic `foxxi:affordance-invoked` envelope for handlers
 * without a more specific verb.
 *
 * Standards anchored:
 *   - Foxxi xAPI Profile v1 (src/xapi-profile.ts)
 *   - xAPI 2.0 Statement requirements §4.1 (actor / verb / object)
 *   - cmi5 context-categories on course-life-cycle verbs (§7.1.4)
 */

import { storeStatementInternal } from './xapi-lrs.js';
import { FOXXI_NS } from './xapi-profile.js';
import { courseIri } from './course-identity.js';
import { activityIri } from './activity-identity.js';
import { randomUUID } from 'node:crypto';

const ADL = 'http://adlnet.gov/expapi';
// cmi5-defined verbs (satisfied/abandoned/waived) are canonically at w3id — the SAME
// IRIs the published profile declares, so the emitter and the concept set agree.
const ADLW3 = 'https://w3id.org/xapi/adl/verbs';
const CMI5_CAT = 'https://w3id.org/xapi/cmi5/context/categories/cmi5';

interface CallerCtx {
  webId?: string;
  userId?: string;
  role?: string;
  audienceTags?: readonly string[];
}

interface EmissionArgs {
  toolName: string;
  caller: CallerCtx;
  args: Record<string, unknown>;
  result: unknown;
  duration: number;
  isError: boolean;
  selfBaseUrl: string;
}

interface VerbBinding {
  verbId: string;
  display: string;
  objectId: (args: EmissionArgs) => string;
  objectType?: string;
  objectName?: (args: EmissionArgs) => string;
}

// Mapping: tool name → Foxxi-Profile-conformant verb + activity binding.
// Tools without an entry fall through to the generic affordance-invoked
// envelope.
const TOOL_VERBS: Record<string, VerbBinding> = {
  'foxxi.discover_assigned_courses': {
    verbId: `${ADL}/verbs/experienced`, display: 'experienced',
    objectId: () => activityIri('assignments-catalog'), objectType: `${ADL}/activities/course`, objectName: () => 'Assigned courses',
  },
  'foxxi.consume_lesson': {
    verbId: `${ADL}/verbs/launched`, display: 'launched',
    objectId: (a) => courseIri((a.args.course_id as string) ?? 'unknown'), objectType: `${ADL}/activities/course`,
    objectName: (a) => (a.args.course_title as string) ?? (a.args.course_id as string),
  },
  'foxxi.ask_course_question': {
    verbId: `${FOXXI_NS}verbs/asked`, display: 'asked',
    objectId: (a) => activityIri('question', (a.args.course_iri as string) ?? 'unknown'),
    objectType: `${FOXXI_NS}activities/concept-graph-node`,
  },
  'foxxi.ask_course_question_agentic': {
    verbId: `${FOXXI_NS}verbs/asked`, display: 'asked',
    objectId: (a) => activityIri('question-agentic', (a.args.course_id as string) ?? 'unknown'),
    objectType: `${FOXXI_NS}activities/concept-graph-node`,
  },
  'foxxi.retrieve_course_context': {
    verbId: `${FOXXI_NS}verbs/retrieved`, display: 'retrieved',
    objectId: (a) => activityIri('retrieval', (a.args.course_id as string) ?? 'unknown'),
    objectType: `${FOXXI_NS}activities/concept-graph-node`,
  },
  'foxxi.issue_completion_credential': {
    verbId: `${FOXXI_NS}verbs/credentialed`, display: 'credentialed',
    objectId: (a) => activityIri('credential', (a.args.course_id as string) ?? 'unknown'),
    objectType: `${FOXXI_NS}activities/credential`,
    objectName: (a) => `Course completion credential for ${(a.args.course_title as string) ?? 'course'}`,
  },
  'foxxi.export_clr': {
    verbId: `${FOXXI_NS}verbs/wallet-exported`, display: 'wallet-exported',
    objectId: (a) => activityIri('wallet-clr', (a.args.learner_did as string) ?? 'unknown'),
    objectType: `${FOXXI_NS}activities/credential`,
  },
  'foxxi.declare_framework_alignment': {
    verbId: `${FOXXI_NS}verbs/framework-aligned`, display: 'framework-aligned',
    objectId: (a) => activityIri('framework-alignment', (a.args.own_item_iri as string) ?? 'unknown'),
    objectType: `${FOXXI_NS}activities/framework`,
  },
  'foxxi.emit_cmi5_session': {
    verbId: `${ADLW3}/satisfied`, display: 'satisfied',
    objectId: (a) => courseIri((a.args.course_id as string) ?? 'unknown'),
    objectType: `${ADL}/activities/course`,
  },
};

function callerActor(ctx: CallerCtx, selfBaseUrl: string): Record<string, unknown> {
  if (!ctx.webId) {
    return {
      objectType: 'Agent',
      name: 'anonymous-bridge-caller',
      account: { homePage: selfBaseUrl, name: 'anonymous' },
    };
  }
  return {
    objectType: 'Agent',
    name: ctx.userId ?? ctx.webId,
    account: { homePage: new URL(ctx.webId).origin, name: ctx.userId ?? ctx.webId },
  };
}

function pickObject(binding: VerbBinding | undefined, args: EmissionArgs): Record<string, unknown> {
  if (binding) {
    return {
      objectType: 'Activity',
      id: binding.objectId(args),
      definition: {
        name: binding.objectName ? { en: binding.objectName(args) } : undefined,
        type: binding.objectType,
      },
    };
  }
  // Fallback envelope: treat the affordance itself as the Activity.
  return {
    objectType: 'Activity',
    id: `${args.selfBaseUrl}/affordance/${encodeURIComponent(args.toolName)}`,
    definition: {
      name: { en: args.toolName },
      type: `${FOXXI_NS}activities/affordance`,
    },
  };
}

/**
 * Build + store the xAPI statement for a single affordance invocation.
 * Returns the stored statement id (or undefined if emission was skipped,
 * e.g. instrumentation disabled).
 */
export function emitAffordanceStatement(args: EmissionArgs): string | undefined {
  const binding = TOOL_VERBS[args.toolName];
  const verbId = binding?.verbId ?? `${FOXXI_NS}verbs/affordance-invoked`;
  const display = binding?.display ?? 'affordance-invoked';

  const statement: Record<string, unknown> = {
    id: randomUUID(),
    version: '2.0.0',
    actor: callerActor(args.caller, args.selfBaseUrl),
    verb: { id: verbId, display: { en: display } },
    object: pickObject(binding, args),
    timestamp: new Date().toISOString(),
    result: {
      success: !args.isError,
      duration: `PT${(args.duration / 1000).toFixed(3)}S`,
    },
    context: {
      registration: undefined,
      contextActivities: {
        category: [
          { id: `${args.selfBaseUrl}/xapi/profile`, definition: { type: 'http://w3id.org/xapi/profiles' } },
          ...(binding?.verbId?.startsWith(`${ADL}/verbs/`) ? [{ id: CMI5_CAT }] : []),
        ],
        grouping: [{ id: 'urn:foxxi:bridge:affordance-stream' }],
      },
      extensions: {
        [`${FOXXI_NS}affordanceTool`]: args.toolName,
        [`${FOXXI_NS}callerRole`]: args.caller.role,
        [`${FOXXI_NS}durationMs`]: args.duration,
        [`${FOXXI_NS}error`]: args.isError,
      },
    },
  };

  return storeStatementInternal(statement);
}
