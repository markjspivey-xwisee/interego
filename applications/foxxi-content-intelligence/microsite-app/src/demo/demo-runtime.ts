/**
 * The demo orchestrator. Two FRESH agents run an emergent teach -> perform ->
 * credential arc on the live Foxxi bridge. The phase sequence is the scenario;
 * the tool calls within each phase are the model's own decisions over the real
 * affordances. Every event emitted is backed by a real signed bridge call.
 */
import { freshAgent, type AgentWallet } from './agent-signing.js';
import { dispatchTool, toolList, type DispatchCtx, type ToolName } from './agent-tools.js';
import { runAgentLoop } from './anthropic-runner.js';

export type EventKind = 'identity' | 'phase' | 'thinking' | 'tool-call' | 'auth' | 'xapi' | 'scorm' | 'credential' | 'verify' | 'error' | 'done';
export interface DemoEvent {
  id: number;
  agent: 'A' | 'B' | 'sys';
  kind: EventKind;
  title: string;
  detail?: string;
  data?: unknown;
  ts: string;
}
export type Emit = (e: Omit<DemoEvent, 'id' | 'ts'>) => void;

const A_SYSTEM = `You are Agent A, an autonomous performance engineer on the Interego/Foxxi substrate. You hold a self-sovereign did:ethr identity and act ONLY through the provided tools (real affordances on the live Foxxi bridge). You teach other agents by authoring real, standards-conformant artifacts. Be decisive: take the next concrete tool action toward the goal; do not ask questions. When the goal is met, reply with a one-line DONE summary and stop.`;
const B_SYSTEM = `You are Agent B, an autonomous agent learning a new capability on the Interego/Foxxi substrate. You hold a self-sovereign did:ethr identity and act ONLY through the provided tools (real affordances on the live Foxxi bridge). Read what you are taught, complete the course honestly, then demonstrate the skill for real. Be decisive: take the next concrete tool action; do not ask questions. When done, reply with a one-line DONE summary and stop.`;

const STD_EXT_IRI = 'https://markjspivey-xwisee.github.io/interego/applications/agentic-performance-practice/agp#StandardsExtension';

/** Build a dispatch fn for one agent that makes real calls + emits semantic events. */
function makeDispatch(agent: AgentWallet, who: 'A' | 'B', emit: Emit, ctx: DispatchCtx) {
  return async (name: string, input: Record<string, unknown>): Promise<{ text: string }> => {
    emit({ agent: who, kind: 'tool-call', title: `affordance · ${name}`, detail: summarizeInput(name, input), data: input });
    const r = await dispatchTool(name, input, agent, ctx);
    emit({ agent: who, kind: 'auth', title: `signed call → ${name}`, detail: `did:ethr:${agent.address.slice(0, 10)}… · HTTP ${r.status}${r.ok ? ' ✓' : ' ✗'}` });
    interpret(name, r.body, who, emit);
    return { text: typeof r.body === 'string' ? r.body : JSON.stringify(r.body) };
  };
}

function summarizeInput(name: string, input: Record<string, unknown>): string {
  if (name === 'extend_standards') return `${input.kind} "${input.name}"`;
  if (name === 'scorm_author') return `course "${input.courseId}" (${Array.isArray(input.scos) ? input.scos.length : 0} SCO)`;
  if (name === 'scorm_launch') return `course ${input.course_id}`;
  if (name === 'scorm_submit') return Array.isArray(input.answers) ? `answers: ${(input.answers as string[]).join(', ')}` : 'continue';
  if (name === 'record_performance') return String(input.task_name ?? '');
  if (name === 'review_record') return `subject ${String(input.subject_did ?? 'self').slice(0, 18)}…`;
  if (name === 'issue_credential') return `${input.competency_name} → ${String(input.recipient_did ?? '').slice(0, 18)}…`;
  return '';
}

/** Parse a real bridge response into the live-stream semantic events. */
function interpret(name: string, body: unknown, who: 'A' | 'B', emit: Emit): void {
  const b = (body ?? {}) as Record<string, any>;
  if (name === 'scorm_author' && b.ok) emit({ agent: who, kind: 'scorm', title: 'SCORM course authored', detail: `${b.courseId} · manifest valid · ${b.scoCount} SCO · mastery ${b.masteryScore}`, data: b });
  else if (name === 'scorm_launch' && b.ok) emit({ agent: who, kind: 'scorm', title: 'SCORM registration · launched', detail: `session ${String(b.sessionId).slice(0, 8)}… · SCO "${b.sco?.title ?? ''}"`, data: b });
  else if (name === 'scorm_submit') {
    if (b.done) emit({ agent: who, kind: 'scorm', title: `course ${b.passed ? 'PASSED' : 'completed'}`, detail: `score ${b.score} · ${b.recordedStatements} xAPI statements rolled up`, data: b });
    else if (b.graded) emit({ agent: who, kind: 'scorm', title: 'SCO graded', detail: `${b.graded.correct}/${b.graded.total} correct`, data: b.graded });
  }
  else if (name === 'record_performance' && (b.ok || b.statementId)) emit({ agent: who, kind: 'xapi', title: 'xAPI · performed', detail: `statement ${String(b.statementId ?? '').slice(0, 8)}…`, data: b });
  else if (name === 'extend_standards' && (b.ok || b.iri)) emit({ agent: who, kind: 'xapi', title: 'standards extension authored', detail: String(b.iri ?? b['@id'] ?? ''), data: b });
  else if (name === 'review_record' && b.ok) {
    const comps = (b.elr?.competencies ?? []) as Array<Record<string, unknown>>;
    emit({ agent: who, kind: 'verify', title: 'capability-transfer verified', detail: `${b.subject?.statementCount ?? 0} statements · competencies: ${comps.map(c => c.label ?? c.id).join('; ') || 'none'}`, data: b.elr });
  }
  else if (name === 'issue_credential' && b.ok) emit({ agent: who, kind: 'credential', title: 'credential issued (OB3)', detail: `${b.competencyName ?? ''} → issuer ${String(b.issuerDid ?? '').slice(0, 16)}…`, data: b });
  else if (b.error || b.ok === false) emit({ agent: who, kind: 'error', title: `${name} error`, detail: String(b.error ?? `HTTP error`), data: b });
}

export interface DemoHandle { agentA: string; agentB: string; courseId: string }

/** Run the full demo. Throws on Anthropic/transport errors (surfaced in the UI). */
export async function runDemo(apiKey: string, emit: Emit): Promise<void> {
  const A = freshAgent();
  const B = freshAgent();
  const courseId = `agp-extend-${A.address.slice(2, 8)}`;
  emit({ agent: 'A', kind: 'identity', title: 'fresh agent A (teacher · issuer · observer)', detail: A.did });
  emit({ agent: 'B', kind: 'identity', title: 'fresh agent B (learner · performer)', detail: B.did });

  // ── Phase 1: A authors the extension + the SCORM course ──────────────
  emit({ agent: 'sys', kind: 'phase', title: 'Phase 1 — Agent A authors a custom xAPI extension + a SCORM course that teaches the skill' });
  await runAgentLoop({
    apiKey, system: A_SYSTEM,
    goal: `Your goal: teach another agent the capability "extend a standard (xAPI/IEEE-LER/ADL-TLA) in Interego/Foxxi".\n` +
      `1) First author the supporting xAPI vocabulary with extend_standards (kind XapiProfileFragment, a sensible name + definition).\n` +
      `2) Then author a SCORM course with scorm_author. Use courseId EXACTLY "${courseId}". Give it ONE assessment SCO whose body explains: discover the /guidance catalog, then call the extend_standards affordance, and that WHAT was done rides in the object's conformsTo, not the verb. Add an assessment of 2 {question, answer} pairs that test those two facts (keep answers short single words/phrases). masteryScore 0.5.\n` +
      `When the course is authored (manifestValid), reply DONE with the courseId.`,
    tools: toolList(['get_guidance', 'extend_standards', 'scorm_author'] as ToolName[]),
    dispatch: makeDispatch(A, 'A', emit, {}),
    onThinking: t => emit({ agent: 'A', kind: 'thinking', title: 'reasoning', detail: t }),
    onToolCall: () => {}, onToolResult: () => {},
    maxSteps: 8,
  });

  // ── Phase 2: B learns the course, then performs the skill ────────────
  emit({ agent: 'sys', kind: 'phase', title: 'Phase 2 — Agent B completes the assigned course, then performs the learned skill' });
  await runAgentLoop({
    apiKey, system: B_SYSTEM,
    goal: `You have been assigned SCORM course "${courseId}", authored by ${A.did}.\n` +
      `1) Launch it with scorm_launch (course_id "${courseId}", author_did "${A.did}").\n` +
      `2) Read the SCO body, then call scorm_submit with your answers (array of short strings, in order). Repeat scorm_submit until the response says done:true. Aim to PASS.\n` +
      `3) Now demonstrate the skill for real: call extend_standards to author your own extension, then record_performance (task_name about extending a standard, success true, quality ~0.9, activity_type "${STD_EXT_IRI}").\n` +
      `Reply DONE when you have completed the course AND performed the skill.`,
    tools: toolList(['get_guidance', 'scorm_launch', 'scorm_submit', 'extend_standards', 'record_performance'] as ToolName[]),
    dispatch: makeDispatch(B, 'B', emit, { authorDid: A.did }),
    onThinking: t => emit({ agent: 'B', kind: 'thinking', title: 'reasoning', detail: t }),
    onToolCall: () => {}, onToolResult: () => {},
    maxSteps: 12,
  });

  // ── Phase 3: A verifies the transfer + issues the credential ─────────
  emit({ agent: 'sys', kind: 'phase', title: 'Phase 3 — Agent A verifies the capability transferred, then issues Agent B a credential' });
  await runAgentLoop({
    apiKey, system: A_SYSTEM,
    goal: `Agent B (${B.did}) was supposed to learn and demonstrate "extend a standard".\n` +
      `1) Verify it: call review_record with subject_did "${B.did}" (no admin token needed). Inspect the returned ELR competencies for evidence B both completed the course AND performed the skill.\n` +
      `2) If the evidence is there, call issue_credential (recipient_did "${B.did}", competency_name "Standards Extension", a short achievement_description).\n` +
      `Reply DONE with whether the credential was issued.`,
    tools: toolList(['review_record', 'issue_credential'] as ToolName[]),
    dispatch: makeDispatch(A, 'A', emit, { subjectDid: B.did }),
    onThinking: t => emit({ agent: 'A', kind: 'thinking', title: 'reasoning', detail: t }),
    onToolCall: () => {}, onToolResult: () => {},
    maxSteps: 6,
  });

  emit({ agent: 'sys', kind: 'done', title: 'Demo complete — discover → author → assign → complete → perform → verify → credential, all emergent + live' });
}
