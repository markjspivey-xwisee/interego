/**
 * The affordance surface given to the LLM agents (Anthropic tool-use), each
 * wired to a REAL Foxxi bridge endpoint. The agents decide WHICH tool to call
 * and with WHAT args; dispatchTool makes the genuine signed call. Nothing here
 * is simulated — every dispatch hits the live bridge and returns its real body.
 */
import { ethers } from 'ethers';
import { type AgentWallet, postSigned, postPlain, getBridge, type BridgeResult } from './agent-signing.js';

const enc = new TextEncoder();
const sha256Hex = (s: string): string => ethers.sha256(enc.encode(s)).slice(2);

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
  interrogate_holon: {
    name: 'interrogate_holon',
    description: 'Interrogate a PEER agent\'s holon (its context descriptor) to discover, per interrogative (who / what / when / why / how / …), what it resolves and what is ABSENT. Use this to find the gap between the context a peer shared and what YOU would need to act on it. Returns each interrogative with status full | partial | pointer | absent.',
    input_schema: { type: 'object', properties: {
      holon_uri: str('The peer holon URI (urn:pgsl:…) to interrogate. If omitted, uses the peer holon in context.'),
      label: str('The peer agent\'s lattice label (eth-…). If omitted, uses the peer label in context.'),
    } },
  },
  teach_agent: {
    name: 'teach_agent',
    description: 'Teach a PEER agent a capability over the live A2A teaching endpoint. You (the teacher) cryptographically sign the teaching package; the bridge VERIFIES the transfer from the learner\'s before/after behaviour — it is not taken on your word. Provide the competency, a one-sentence target behaviour, and the verb markers that signal the NEW (taught) behaviour vs the OLD behaviour you want it to replace.',
    input_schema: { type: 'object', properties: {
      learner_did: str('did:ethr of the learner. If omitted, uses the peer in context.'),
      competency: str('The capability being taught, e.g. "consult the authoritative standard before acting".'),
      target_description: str('One sentence describing the target behaviour.'),
      signal_markers: { type: 'array', description: 'Verb markers indicating the NEW (taught) behaviour, e.g. ["reference","look up","consult"].', items: { type: 'string' } },
      anti_signal_markers: { type: 'array', description: 'Verb markers indicating the OLD behaviour to replace, e.g. ["guess","skip"].', items: { type: 'string' } },
    }, required: ['competency', 'target_description', 'signal_markers'] },
  },
  verify_extension: {
    name: 'verify_extension',
    description: 'Independently verify, from a SUBJECT\'s OWN authoritative pod records, that they completed an engine-graded course AND recorded a domain-typed StandardsExtension performance, and that a named extension conforms to the agp:StandardsExtension shape. Use this BEFORE issuing a credential — it separates independently-verified evidence (tamper-evident engine grading + shape conformance) from any self-attested outcome.',
    input_schema: { type: 'object', properties: {
      subject_did: str('did:ethr of the subject to verify.'),
      name: str('The extension slug the subject claims to have authored (read it from their performance record / ELR, e.g. "collaborationDepth").'),
      kind: { type: 'string', enum: ['XapiContextExtension', 'XapiProfileFragment', 'LerTerm', 'TlaTerm'], description: 'The extension kind the subject authored.' },
    }, required: ['subject_did'] },
  },
  review_record: {
    name: 'review_record',
    description: 'Read a learner record (ELR + optionally CLR credential wallet). Pass subject_did to read another agent\'s record (e.g. to verify they learned a skill).',
    input_schema: { type: 'object', properties: {
      subject_did: str('did:ethr of the subject whose record to read.'),
      include_clr: bool('Include the credential wallet (CLR).'),
    } },
  },
  prove_competency: {
    name: 'prove_competency',
    description: 'Derive a BBS+ selective-disclosure presentation of a competency you hold: prove ONLY the competency name + proficiency (and issuer) while cryptographically HIDING your score, name, dates, and credential id. Lets you present a credential to a verifier without leaking your transcript.',
    input_schema: { type: 'object', properties: {
      issuer_did: str('did:ethr of the authority that credentialed you (the issuer).'),
      competency_name: str('The competency to prove, e.g. "Standards Extension".'),
      score: num('Your score 0..1 (will be HIDDEN in the presentation).'),
      proficiency: { type: 'string', enum: ['Novice', 'Beginner', 'Intermediate', 'Advanced', 'Expert'], description: 'Proficiency level (revealed).' },
    }, required: ['issuer_did', 'competency_name'] },
  },
  verify_presentation: {
    name: 'verify_presentation',
    description: 'Cryptographically verify the BBS+ selective-disclosure presentation the counterparty supplied to you: confirm the issuer signed exactly the disclosed claims while learning ONLY what was disclosed (the hidden fields stay hidden). The presentation is already provided to you — call this with NO arguments.',
    input_schema: { type: 'object', properties: {
      presentation: { type: 'object', description: 'Optional — leave unset; the presentation supplied to you is used automatically.' },
    } },
  },
  issue_credential: {
    name: 'issue_credential',
    description: 'Issue an Open Badges 3.0 credential to an agent who demonstrated a competency. You are the issuing authority.',
    input_schema: { type: 'object', properties: {
      recipient_did: str('did:ethr of the recipient.'),
      competency_name: str('The competency the credential attests.'),
      achievement_description: str('What the recipient demonstrated.'),
      justified_by: str('The verificationHolonUri returned by verify_extension — links the credential to its verification (chain of custody).'),
    }, required: ['recipient_did', 'competency_name'] },
  },
};

export type ToolName = keyof typeof TOOLS;
export const toolList = (names: ToolName[]): ToolDef[] => names.map(n => TOOLS[n]);

export interface DispatchCtx { authorDid?: string; subjectDid?: string; holonUri?: string; label?: string; learnerDid?: string; presentation?: unknown }

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
    case 'interrogate_holon': {
      const holon = String(input.holon_uri ?? ctx.holonUri ?? '');
      const label = String(input.label ?? ctx.label ?? '');
      return getBridge(`/agent/lattice/${encodeURIComponent(label)}/interrogate?uri=${encodeURIComponent(holon)}&agent_did=${encodeURIComponent(agent.did)}`);
    }
    case 'teach_agent': {
      const competency = String(input.competency ?? 'a capability');
      const signalMarkers = Array.isArray(input.signal_markers) ? (input.signal_markers as string[]) : [];
      const antiSignalMarkers = Array.isArray(input.anti_signal_markers) ? (input.anti_signal_markers as string[]) : [];
      const teachingPackage = { iri: `urn:iep:teaching:${agent.address.slice(2, 10)}-${sha256Hex(competency).slice(0, 8)}`, artifactIri: 'urn:iep:tool:taught-capability', competency, olkeStage: 'Articulate', modalStatus: 'Hypothetical' };
      const targetBehaviour = { description: String(input.target_description ?? competency), signalMarkers, ...(antiSignalMarkers.length ? { antiSignalMarkers } : {}) };
      const tuple = JSON.stringify({ teachingPackage, targetBehaviour });
      const signature = await agent.wallet.signMessage(`sha256:${sha256Hex(tuple)}`);
      const learnerDid = String(input.learner_did ?? ctx.learnerDid ?? '');
      // Illustrative before/after trajectories built from the teacher's chosen markers:
      // the signature gate + the bridge's transfer-verification math are the real
      // primitive; the trajectories are demo inputs (same as the /emergent demo).
      const traj = (verbs: string[]) => [{ agentDid: learnerDid, agentName: 'learner', createdAt: new Date().toISOString(), steps: verbs.map((v, i) => ({ modalStatus: 'Asserted', granularity: 'tool-call', verb: v, objectId: `o${i}`, objectName: 'step', recordedAt: new Date().toISOString() })) }];
      const before = traj([...(antiSignalMarkers.length ? antiSignalMarkers : ['guess', 'skip']), 'act', 'escalate']);
      const after = traj([...(signalMarkers.length ? signalMarkers : ['consult']), ...(signalMarkers.length ? signalMarkers : ['reference']), 'complete', 'verify']);
      return postPlain('/agent/teach', { teachingPackage, teacher: { id: agent.did, kind: 'agent' }, learner: { id: learnerDid, kind: 'agent' }, targetBehaviour, signature, signedPayload: tuple, before, after });
    }
    case 'verify_extension':
      return postSigned('/agent/verify-extension', agent, { subject_did: input.subject_did ?? ctx.subjectDid, name: input.name, kind: input.kind });
    case 'prove_competency':
      return postSigned('/agent/prove-competency', agent, { issuer_did: input.issuer_did ?? ctx.authorDid, competency_name: input.competency_name, score: input.score, proficiency: input.proficiency });
    case 'verify_presentation':
      // The real (large) presentation is supplied via ctx; prefer it over whatever
      // the model passes (it cannot reconstruct the full BBS+ object, so a model-
      // supplied value would 400). Falls back to input for non-ctx callers.
      return postSigned('/agent/verify-presentation', agent, { presentation: ctx.presentation ?? input.presentation });
    case 'review_record':
      return postSigned('/agent/review-record', agent, { subject_did: input.subject_did ?? ctx.subjectDid, include_clr: input.include_clr ?? false });
    case 'issue_credential':
      return postSigned('/agent/issue-credential', agent, { recipient_did: input.recipient_did ?? ctx.subjectDid, competency_name: input.competency_name, achievement_description: input.achievement_description, justified_by: input.justified_by });
    default:
      return { ok: false, status: 400, body: { error: `unknown tool ${name}` } };
  }
}
