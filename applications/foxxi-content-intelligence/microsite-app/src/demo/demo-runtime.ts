/**
 * The demo orchestrator. Two FRESH agents run an emergent teach -> perform ->
 * credential arc on the live Foxxi bridge. The phase sequence is the scenario;
 * the tool calls within each phase are the model's own decisions over the real
 * affordances. All run state goes to the shared demo-session store (survives
 * navigation; scopes the Reports page to THIS run's agents).
 */
import { freshAgent, recoverSigner, curlFor, type AgentWallet } from './agent-signing.js';
import { dispatchTool, toolList, type DispatchCtx, type ToolName } from './agent-tools.js';
import { runAgentLoop } from './anthropic-runner.js';
import { resetDemo, setDemoAgent, addDemoEvent, setDemoStatus, type DemoEvent } from './demo-session.js';

type Emit = (e: Omit<DemoEvent, 'id' | 'ts'>) => void;
const emit: Emit = e => addDemoEvent(e);

const A_SYSTEM = `You are Agent A, an autonomous performance engineer on the Interego/Foxxi substrate. You hold a self-sovereign did:ethr identity and act ONLY through the provided tools (real affordances on the live Foxxi bridge). You teach other agents by authoring real, standards-conformant artifacts. Be decisive: take the next concrete tool action toward the goal; do not ask questions. When the goal is met, reply with a one-line DONE summary and stop.`;
const B_SYSTEM = `You are Agent B, an autonomous agent learning a new capability on the Interego/Foxxi substrate. You hold a self-sovereign did:ethr identity and act ONLY through the provided tools (real affordances on the live Foxxi bridge). Read what you are taught, complete the course honestly, then demonstrate the skill for real. Be decisive: take the next concrete tool action; do not ask questions. When done, reply with a one-line DONE summary and stop.`;

const STD_EXT_IRI = 'https://markjspivey-xwisee.github.io/interego/applications/agentic-performance-practice/agp#StandardsExtension';

function makeDispatch(agent: AgentWallet, who: 'A' | 'B', ctx: DispatchCtx) {
  return async (name: string, input: Record<string, unknown>): Promise<{ text: string }> => {
    emit({ agent: who, kind: 'tool-call', title: `affordance · ${name}`, detail: summarizeInput(name, input), data: input });
    const r = await dispatchTool(name, input, agent, ctx);
    // The protocol trace: for signed calls, carry the EXACT rev-196 envelope bytes,
    // the signer recovered from them client-side, and a copy-paste curl recipe — so
    // the dev lens shows the wire, not just "HTTP 200".
    const wire = r.envelope
      ? { envelope: r.envelope, path: r.path, recoveredSigner: recoverSigner(r.envelope), expectedSigner: agent.address.toLowerCase(), curl: curlFor(r.path ?? '', r.envelope) }
      : undefined;
    emit({ agent: who, kind: 'auth', title: `signed call → ${name}`, detail: `did:ethr:${agent.address.slice(0, 10)}… · HTTP ${r.status}${r.ok ? ' ✓' : ' ✗'}${wire ? ' · signer recovered from bytes ✓' : ''}`, data: wire });
    interpret(name, r.body, who);
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
  if (name === 'verify_extension') return `subject ${String(input.subject_did ?? '').slice(0, 14)}… · ${String(input.name ?? '')}`;
  if (name === 'issue_credential') return `${input.competency_name} → ${String(input.recipient_did ?? '').slice(0, 18)}…`;
  return '';
}

function interpret(name: string, body: unknown, who: 'A' | 'B'): void {
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
  else if (name === 'verify_extension' && b.ok) emit({ agent: who, kind: 'verify', title: `independent verification — ${b.verified ? 'PASSED' : 'INSUFFICIENT'}`, detail: `engine-graded:${b.checks?.independentlyGraded}${b.checks?.gradedScore != null ? ` (${b.checks.gradedScore})` : ''} · performance:${b.checks?.performanceRecorded}${b.checks?.selfAttestedPerformance ? ' (self-attested)' : ''} · shape-conformant:${b.checks?.shapeConformant}`, data: b });
  else if (name === 'issue_credential' && b.ok) emit({ agent: who, kind: 'credential', title: 'credential issued (OB3)', detail: `${b.competency?.name ?? b.competencyName ?? 'competency'} → ${String(b.recipient?.did ?? b.recipientDid ?? '').slice(0, 20)}…`, data: b });
  else if (b.error || b.ok === false) emit({ agent: who, kind: 'error', title: `${name} error`, detail: String(b.error ?? `HTTP error`), data: b });
}

/** Run the full demo into the shared store. Never throws — errors land as an
 *  error event + status='error' so the UI reflects them. */
export async function runDemo(apiKey: string): Promise<void> {
  resetDemo();
  try {
    const A = freshAgent();
    const B = freshAgent();
    setDemoAgent('A', { did: A.did, address: A.address, label: A.podLabel, lensTenant: `lens:${A.podLabel}`, role: 'teacher · issuer · observer' });
    setDemoAgent('B', { did: B.did, address: B.address, label: B.podLabel, lensTenant: `lens:${B.podLabel}`, role: 'learner · performer' });
    const courseId = `agp-extend-${A.address.slice(2, 8)}`;
    emit({ agent: 'A', kind: 'identity', title: 'fresh agent A (teacher · issuer · observer)', detail: A.did });
    emit({ agent: 'B', kind: 'identity', title: 'fresh agent B (learner · performer)', detail: B.did });

    emit({ agent: 'sys', kind: 'phase', title: 'Phase 1 — Agent A authors a custom xAPI extension + a SCORM course that teaches the skill' });
    try { await runAgentLoop({
      apiKey, system: A_SYSTEM,
      goal: `Your goal: teach another agent the capability "extend a standard (xAPI/IEEE-LER/ADL-TLA) in Interego/Foxxi".\n` +
        `1) First author the supporting xAPI vocabulary with extend_standards (kind XapiProfileFragment, a sensible name + definition).\n` +
        `2) Then author a SCORM course with scorm_author. Use courseId EXACTLY "${courseId}". Give it ONE assessment SCO whose body explains: discover the /guidance catalog, then call the extend_standards affordance, and that WHAT was done rides in the object's conformsTo, not the verb. Add an assessment of 2 {question, answer} pairs that test those two facts (keep answers short single words/phrases). masteryScore 0.5.\n` +
        `When the course is authored (manifestValid), reply DONE with the courseId.`,
      tools: toolList(['get_guidance', 'extend_standards', 'scorm_author'] as ToolName[]),
      dispatch: makeDispatch(A, 'A', {}),
      onThinking: t => emit({ agent: 'A', kind: 'thinking', title: 'reasoning', detail: t }),
      onToolCall: () => {}, onToolResult: () => {}, maxSteps: 8,
    }); } catch (e) { emit({ agent: 'A', kind: 'error', title: 'phase 1 error (continuing)', detail: (e as Error).message }); }

    emit({ agent: 'sys', kind: 'phase', title: 'Phase 2 — Agent B completes the course, performs the skill, then proves TRANSFER on an untaught standard' });
    try { await runAgentLoop({
      apiKey, system: B_SYSTEM,
      goal: `You have been assigned SCORM course "${courseId}", authored by ${A.did}.\n` +
        `1) Launch it with scorm_launch (course_id "${courseId}", author_did "${A.did}").\n` +
        `2) Read the SCO body, then call scorm_submit with your answers (array of short strings, in order). Repeat scorm_submit until the response says done:true. Aim to PASS.\n` +
        `3) Demonstrate the skill: call extend_standards (kind XapiContextExtension) to author your own extension, then record_performance (task_name about extending a standard, success true, quality ~0.9, activity_type "${STD_EXT_IRI}").\n` +
        `4) Now prove TRANSFER, not memorization: extend a DIFFERENT, UNTAUGHT standard — call extend_standards with kind "LerTerm" OR "TlaTerm" (the course only taught the xAPI kind), a NEW name + definition, then record_performance for it (activity_type "${STD_EXT_IRI}"). Generalizing to a standard nobody taught you is the real evidence you LEARNED rather than parroted.\n` +
        `Reply DONE when you have passed the course, performed the skill, AND extended an untaught standard.`,
      tools: toolList(['get_guidance', 'scorm_launch', 'scorm_submit', 'extend_standards', 'record_performance'] as ToolName[]),
      dispatch: makeDispatch(B, 'B', { authorDid: A.did }),
      onThinking: t => emit({ agent: 'B', kind: 'thinking', title: 'reasoning', detail: t }),
      onToolCall: () => {}, onToolResult: () => {}, maxSteps: 14,
    }); } catch (e) { emit({ agent: 'B', kind: 'error', title: 'phase 2 error (continuing)', detail: (e as Error).message }); }

    emit({ agent: 'sys', kind: 'phase', title: 'Phase 3 — Agent A verifies the capability transferred, then issues Agent B a credential' });
    try { await runAgentLoop({
      apiKey, system: A_SYSTEM,
      goal: `Agent B (${B.did}) was supposed to learn and demonstrate "extend a standard".\n` +
        `1) Read B's record: call review_record with subject_did "${B.did}". Note the competencies AND the name of the extension B authored (e.g. "collaborationDepth").\n` +
        `2) DUE DILIGENCE — do NOT credential on B's self-report alone: call verify_extension (subject_did "${B.did}", name = the extension B authored, kind "XapiContextExtension"). It independently checks, from B's OWN pod, an engine-graded completion + a domain-typed performance + shape conformance, and returns a verificationHolonUri. Proceed ONLY if it returns verified:true (the performance OUTCOME may be self-attested — rely on the tamper-evident engine grading + shape conformance).\n` +
        `3) If verified, call issue_credential (recipient_did "${B.did}", competency_name "Standards Extension", a short achievement_description, AND justified_by = the verificationHolonUri returned in step 2 — this links the credential to its verification as a dereferenceable chain of custody).\n` +
        `Reply DONE with whether the credential was issued and what you INDEPENDENTLY verified.`,
      tools: toolList(['review_record', 'verify_extension', 'issue_credential'] as ToolName[]),
      dispatch: makeDispatch(A, 'A', { subjectDid: B.did }),
      onThinking: t => emit({ agent: 'A', kind: 'thinking', title: 'reasoning', detail: t }),
      onToolCall: () => {}, onToolResult: () => {}, maxSteps: 6,
    }); } catch (e) { emit({ agent: 'A', kind: 'error', title: 'phase 3 error (continuing)', detail: (e as Error).message }); }

    // ── Phase 4 — a fresh THIRD agent independently re-checks B, then B proves its
    //    credential privately (BBS+ selective disclosure). The verification ceremony
    //    is a fixed protocol (the emergence already happened in Phases 1-3); the agents,
    //    signatures, and crypto are all real.
    emit({ agent: 'sys', kind: 'phase', title: 'Phase 4 — an independent third agent re-checks B, then B proves its credential privately' });
    const C = freshAgent();
    setDemoAgent('C', { did: C.did, address: C.address, label: C.podLabel, lensTenant: `lens:${C.podLabel}`, role: 'independent verifier · no prior relationship' });
    emit({ agent: 'C', kind: 'identity', title: 'fresh agent C (independent verifier — nobody told it to trust A or B)', detail: C.did });

    // 1) CONSISTENCY CONFIRMATION — C, with no relationship to A, re-reads B's OWN pod
    //    and re-runs the same checks. Honest: this confirms B's records are durable +
    //    consistent across an independent read; it does NOT re-judge A's course design.
    emit({ agent: 'C', kind: 'tool-call', title: 'affordance · verify_extension', detail: `independently re-check subject ${B.did.slice(0, 16)}…`, data: { subject_did: B.did } });
    const cVer = await dispatchTool('verify_extension', { subject_did: B.did, name: 'collaborationDepth', kind: 'XapiContextExtension' }, C, {});
    emit({ agent: 'C', kind: 'auth', title: 'signed call → verify_extension', detail: `did:ethr:${C.address.slice(0, 10)}… · HTTP ${cVer.status}${cVer.ok ? ' ✓' : ' ✗'}` });
    const cv = (cVer.body ?? {}) as Record<string, any>;
    emit({ agent: 'C', kind: 'verify', title: `independent consistency confirmation — ${cv.verified ? 'CONSISTENT' : 'MISMATCH'}`, detail: `Agent C (no prior relationship to A or B) re-read B's OWN pod and re-ran the verification. This confirms B's evidence is durable + consistent across an independent read — it does NOT re-judge A's course design.`, data: cv });

    // 2) PRIVACY-PRESERVING PROOF — B derives a BBS+ presentation revealing ONLY the
    //    competency + proficiency, cryptographically HIDING score/name/dates/id; C verifies.
    emit({ agent: 'B', kind: 'tool-call', title: 'affordance · prove_competency', detail: 'reveal only the competency — hide score, name, dates, id', data: { issuer_did: A.did, competency_name: 'Standards Extension' } });
    const prove = await dispatchTool('prove_competency', { issuer_did: A.did, competency_name: 'Standards Extension', score: 0.9, proficiency: 'Advanced' }, B, {});
    emit({ agent: 'B', kind: 'auth', title: 'signed call → prove_competency', detail: `did:ethr:${B.address.slice(0, 10)}… · HTTP ${prove.status}${prove.ok ? ' ✓' : ' ✗'}` });
    const pv = (prove.body ?? {}) as Record<string, any>;
    emit({ agent: 'B', kind: 'credential', title: 'selective-disclosure proof derived (BBS+)', detail: `revealed ${pv.revealed?.length ?? 0} claim(s); ${pv.hiddenPaths?.length ?? 0} cryptographically hidden`, data: pv });

    if (pv.presentation) {
      emit({ agent: 'C', kind: 'tool-call', title: 'affordance · verify_presentation', detail: 'verify the BBS+ proof — learn ONLY what B disclosed', data: { presentation: '… (selective-disclosure proof)' } });
      const vp = await dispatchTool('verify_presentation', { presentation: pv.presentation }, C, {});
      emit({ agent: 'C', kind: 'auth', title: 'signed call → verify_presentation', detail: `did:ethr:${C.address.slice(0, 10)}… · HTTP ${vp.status}${vp.ok ? ' ✓' : ' ✗'}` });
      const vv = (vp.body ?? {}) as Record<string, any>;
      emit({ agent: 'C', kind: 'verify', title: `presentation verified (BBS+) — ${vv.verified ? 'PASSED' : 'FAILED'}`, detail: `C cryptographically confirmed the issuer signed exactly the disclosed claims, and learned ONLY: ${(vv.disclosed ?? []).map((d: any) => d.path.replace(/^achievement\./, '')).join(', ')} — the score, name, and dates stayed hidden.`, data: vv });
    }

    emit({ agent: 'sys', kind: 'done', title: 'Demo complete — author → teach → complete → perform → verify → credential → independent re-check → private proof, all live' });
    setDemoStatus('done');
  } catch (e) {
    emit({ agent: 'sys', kind: 'error', title: 'run halted', detail: (e as Error).message });
    setDemoStatus('error', (e as Error).message);
  }
}
