/**
 * The affordance surface given to the LLM agents (Anthropic tool-use), each
 * wired to a REAL Foxxi bridge endpoint. The agents decide WHICH tool to call
 * and with WHAT args; dispatchTool makes the genuine signed call. Nothing here
 * is simulated — every dispatch hits the live bridge and returns its real body.
 */
import { type AgentWallet, postSigned, postPlain, getBridge, type BridgeResult } from './agent-signing.js';

export interface ToolDef {
  name: string;
  description: string;
  input_schema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
}

const str = (description: string) => ({ type: 'string', description });
const bool = (description: string) => ({ type: 'boolean', description });
const num = (description: string) => ({ type: 'number', description });

export const TOOLS: Record<string, ToolDef> = {
  get_guidance: {
    name: 'get_guidance',
    description: 'Read the in-flow performance-support catalog: what each capability does, the competency it builds, and how to learn it. Use this first if unsure how to proceed.',
    input_schema: { type: 'object', properties: {} },
  },
  extend_standards: {
    name: 'extend_standards',
    description: 'Author an extension to a standard (xAPI / IEEE-LER / ADL-TLA) — a context extension, an xAPI Profile fragment, or a LER/TLA term. Composes Foxxi\'s standards; returns a conformant, self-descriptive artifact.',
    input_schema: { type: 'object', properties: {
      kind: { type: 'string', enum: ['XapiContextExtension', 'XapiProfileFragment', 'LerTerm', 'TlaTerm'], description: 'What to author.' },
      name: str('Local slug for the new term/extension, e.g. "collaborationDepth".'),
      definition: str('Human-readable definition.'),
    }, required: ['kind', 'name', 'definition'] },
  },
  scorm_author: {
    name: 'scorm_author',
    description: 'Author a SCORM course (real SCORM 2004 SN manifest). Each SCO has a body (the lesson) and an optional assessment of {question, answer} pairs (graded by the runtime).',
    input_schema: { type: 'object', properties: {
      courseId: str('Stable course id.'),
      title: str('Course title.'),
      masteryScore: num('Pass threshold 0..1 (default 0.5).'),
      scos: { type: 'array', description: 'SCOs: [{ id, title, body, assessment?: [{question, answer}] }].', items: { type: 'object' } },
    }, required: ['courseId', 'title', 'scos'] },
  },
  scorm_launch: {
    name: 'scorm_launch',
    description: 'Launch a SCORM course you have been assigned. Returns a session_id + the first SCO to read.',
    input_schema: { type: 'object', properties: {
      course_id: str('The course id to launch.'),
      author_did: str('did:ethr of the agent that authored the course (so it loads from their pod).'),
    }, required: ['course_id'] },
  },
  scorm_submit: {
    name: 'scorm_submit',
    description: 'Submit your answers for the current SCO. For an assessment SCO pass answers (array of strings, in order). Repeat until the response says done:true.',
    input_schema: { type: 'object', properties: {
      session_id: str('The launch session id.'),
      answers: { type: 'array', description: 'Your answers to the current SCO assessment, in order.', items: { type: 'string' } },
    }, required: ['session_id'] },
  },
  record_performance: {
    name: 'record_performance',
    description: 'Record a unit of production work you performed (a real xAPI performed statement into your own record). Use after you actually did the work.',
    input_schema: { type: 'object', properties: {
      task_name: str('What you performed.'),
      success: bool('Whether it succeeded.'),
      quality: num('Quality 0..1.'),
      activity_type: str('The activity-type IRI (e.g. the agp:StandardsExtension IRI).'),
    }, required: ['task_name', 'success'] },
  },
  review_record: {
    name: 'review_record',
    description: 'Read a learner record (ELR + optionally CLR credential wallet). Pass subject_did to read another agent\'s record (e.g. to verify they learned a skill).',
    input_schema: { type: 'object', properties: {
      subject_did: str('did:ethr of the subject whose record to read.'),
      include_clr: bool('Include the credential wallet (CLR).'),
    } },
  },
  issue_credential: {
    name: 'issue_credential',
    description: 'Issue an Open Badges 3.0 credential to an agent who demonstrated a competency. You are the issuing authority.',
    input_schema: { type: 'object', properties: {
      recipient_did: str('did:ethr of the recipient.'),
      competency_name: str('The competency the credential attests.'),
      achievement_description: str('What the recipient demonstrated.'),
    }, required: ['recipient_did', 'competency_name'] },
  },
};

export type ToolName = keyof typeof TOOLS;
export const toolList = (names: ToolName[]): ToolDef[] => names.map(n => TOOLS[n]);

export interface DispatchCtx { authorDid?: string; subjectDid?: string }

/** Make the real bridge call for a tool the LLM chose. */
export async function dispatchTool(name: string, input: Record<string, unknown>, agent: AgentWallet, ctx: DispatchCtx = {}): Promise<BridgeResult> {
  switch (name) {
    case 'get_guidance':
      return getBridge('/guidance');
    case 'extend_standards':
      return postPlain('/agent/extend-standards', { kind: input.kind, name: input.name, definition: input.definition });
    case 'scorm_author':
      return postSigned('/agent/scorm/author', agent, { course: {
        courseId: input.courseId, title: input.title,
        masteryScore: typeof input.masteryScore === 'number' ? input.masteryScore : 0.5,
        scos: input.scos,
      } });
    case 'scorm_launch':
      return postSigned('/agent/scorm/launch', agent, { course_id: input.course_id, author_did: input.author_did ?? ctx.authorDid });
    case 'scorm_submit':
      return postSigned('/agent/scorm/submit', agent, { session_id: input.session_id, answers: input.answers });
    case 'record_performance':
      return postSigned('/agent/record-performance', agent, { task_name: input.task_name, success: input.success ?? true, quality: input.quality, activity_type: input.activity_type });
    case 'review_record':
      return postSigned('/agent/review-record', agent, { subject_did: input.subject_did ?? ctx.subjectDid, include_clr: input.include_clr ?? false });
    case 'issue_credential':
      return postSigned('/agent/issue-credential', agent, { recipient_did: input.recipient_did ?? ctx.subjectDid, competency_name: input.competency_name, achievement_description: input.achievement_description });
    default:
      return { ok: false, status: 400, body: { error: `unknown tool ${name}` } };
  }
}
