/**
 * Live ops for the W3C-convergence demo. Each maps an Interego primitive to a
 * W3C effort, composing EXISTING bridge endpoints (no new substrate):
 *   - Holon (W3C Holon CG): mint a real holon -> dereference the iep: descriptor
 *     + read the lattice holarchy (whole + part).
 *   - Context gap (W3C Context Graphs CG): interrogate -> per-interrogative
 *     resolution state (full/partial/pointer/absent). `absent` = the answering
 *     facet is not on this descriptor = the unresolved-context PRECONDITION a
 *     safe-stop keys on (NOT an abstain/escalate trigger the call performs; that
 *     gap-detection predicate is not yet wired — see docs/NAME-PROVENANCE.md §6).
 *   - DataBook (Cagle): ingest a Markdown DataBook -> holon; emit a SKILL.md back.
 * BYOK (optional, key stays in this tab): an LLM authors a DataBook from a plain
 * description; everything else runs keyless.
 */
import { ethers } from 'ethers';
import { freshAgent, postSigned, type AgentWallet } from './agent-signing.js';
import { dispatchTool, toolList, type DispatchCtx, type ToolName } from './agent-tools.js';
import { runAgentLoop } from './anthropic-runner.js';
import { bridgeRest, BRIDGE_URL } from '../bridge-client.js';

const STD = 'https://markjspivey-xwisee.github.io/interego/applications/agentic-performance-practice/agp#StandardsExtension';
const STD_TOPIC = 'extend an interoperability standard (xAPI / IEEE-LER / ADL-TLA) without forking it';
export const PAGES_NS = 'https://markjspivey-xwisee.github.io/interego/ns';
const enc = new TextEncoder();
const sha256Hex = (s: string): string => ethers.sha256(enc.encode(s)).slice(2);

export interface MintedHolon {
  agent: AgentWallet; label: string; did: string;
  holonUri?: string; descriptorUrl?: string;
  reusedNodes?: number; newNodes?: number;
  stats?: { atoms?: number; fragments?: number; totalNodes?: number; maxLevel?: number; levels?: Record<string, number> };
  siblingHolonUri?: string;  // a prior holon in the SAME lattice that this one shares atoms with
  raw?: unknown;
}

async function record(a: AgentWallet, taskName: string) {
  const r = await postSigned('/agent/record-performance', a, { task_name: taskName, success: true, quality: 1, activity_type: STD });
  const b = (r.body ?? {}) as any;
  return { ok: r.ok, status: r.status, b, sl: (b.sharedLattice ?? {}) as any };
}

/**
 * Mint a real holon on the live bridge with a fresh self-sovereign wallet. To
 * actually DEMONSTRATE the hypergraph holarchy (one atom shared by many wholes),
 * we mint a sibling first, then THIS holon, in the SAME agent's lattice — so the
 * returned holon's `reusedNodes` is the count of atoms it genuinely shares with
 * its sibling (the agent DID, the verb, the activity-type), not a synthetic claim.
 * Fails loudly if the bridge did not compose a holon (never fabricates success).
 */
export async function mintHolon(taskName = 'A holon, minted live'): Promise<MintedHolon> {
  const a = freshAgent();
  const label = `eth-${a.address.slice(2, 14)}`;
  const first = await record(a, 'A sibling holon, sharing this agent’s lattice');
  if (!first.ok || !first.sl.holonUri) throw new Error(`mint failed: HTTP ${first.status}${first.b?.error ? ` — ${first.b.error}` : ''}${first.b?.hint ? ` (${first.b.hint})` : ''}`.slice(0, 200));
  const r = await record(a, taskName);
  if (!r.ok || !r.sl.holonUri) throw new Error(`mint failed: HTTP ${r.status}${r.b?.error ? ` — ${r.b.error}` : ''}`.slice(0, 200));
  const sl = r.sl;
  return { agent: a, label, did: a.did, holonUri: sl.holonUri, descriptorUrl: sl.descriptorUrl, reusedNodes: sl.reusedNodes, newNodes: sl.newNodes, stats: sl.stats, siblingHolonUri: first.sl.holonUri, raw: r.b };
}

/** Dereference the holon's projected descriptor (the WHOLE) — its iep: Turtle.
 *  css-gate allows the microsite origin; best-effort with one retry (async persist). */
export async function dereferenceDescriptor(url: string): Promise<{ ok: boolean; turtle?: string; status: number }> {
  for (const wait of [0, 1500]) {
    if (wait) await new Promise(r => setTimeout(r, wait));
    try {
      const r = await fetch(url, { headers: { Accept: 'text/turtle' } });
      if (r.ok) return { ok: true, turtle: await r.text(), status: r.status };
      if (wait) return { ok: false, status: r.status };
    } catch { /* retry once */ }
  }
  return { ok: false, status: 0 };
}

export interface InterrogativeAnswer { interrogative: string; status: 'full' | 'partial' | 'pointer' | 'absent' | string; values?: Record<string, unknown>; caveat?: string; nextStep?: { tool?: string }; }

/** Interrogate a holon — the per-interrogative resolution state IS the
 *  context-gap resolution state; absent/pointer + caveat == safe-stop. */
export async function interrogateHolon(label: string, holonUri: string, did: string): Promise<{ answers: InterrogativeAnswer[]; error?: string }> {
  try {
    const url = `${BRIDGE_URL}/agent/lattice/${label}/interrogate?uri=${encodeURIComponent(holonUri)}&agent_did=${encodeURIComponent(did)}`;
    const r = await fetch(url);
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok || j?.ok === false) return { answers: [], error: j?.error || `HTTP ${r.status}` };
    return { answers: Array.isArray(j.answers) ? j.answers : [] };
  } catch (e) { return { answers: [], error: (e as Error).message }; }
}

export interface DataBookIngest { ok: boolean; error?: string; course?: any; holonUri?: string; descriptorUrl?: string; label?: string; concepts?: number; }

/** Ingest a DataBook-shaped Markdown (frontmatter + fenced turtle) into a holon. */
export async function ingestDataBook(markdown: string): Promise<DataBookIngest> {
  const { status, json } = await bridgeRest('/agent/course/analyze-skill', { skillMd: markdown });
  if (status !== 200 || (json as any).ok === false) return { ok: false, error: String((json as any).error ?? `HTTP ${status}`) };
  const j = json as any;
  return { ok: true, course: j.course, holonUri: j.courseKg?.holonUri, descriptorUrl: j.courseKg?.descriptorUrl, label: j.courseKg?.label, concepts: j.course?.concepts?.length };
}

/** Round-trip: emit a SKILL.md (markdown-carrier-of-semantics) from the holon. */
export async function emitSkill(course: any, holonUri?: string): Promise<{ ok: boolean; skillMd?: string; error?: string }> {
  const { status, json } = await bridgeRest('/agent/course/skill', { course, tool: 'DataBook', holonUri });
  if (status !== 200 || (json as any).ok === false) return { ok: false, error: String((json as any).error ?? `HTTP ${status}`) };
  return { ok: true, skillMd: String((json as any).skillMd ?? '') };
}

export interface SkillAffordance {
  ok: boolean; error?: string;
  skillIri?: string; graphIri?: string;
  graphContent?: string; roundTripMd?: string;
  validation?: Array<{ message?: string; path?: string; [k: string]: unknown }>;
}

/**
 * The STRICT translator: SKILL.md → a real `iep:Affordance` ContextDescriptor
 * graph and back, via the CORE `@interego/skills` bridge
 * (`skillBundleToDescriptor` / `descriptorGraphToSkillMd`) running on the live
 * bridge. This is the literal agentskills.io ⇄ iep:Affordance translator — the
 * one the DataBook panel honestly disclaims it is NOT. The returned graph's
 * subject is typed `iep:Affordance, ieh:Affordance, hydra:Operation,
 * dcat:Distribution`; the round-trip proves the translation is lossless for the
 * core fields. Pure translation — no pod write, no signing.
 */
export async function skillToAffordance(skillMd: string, agentDid?: string): Promise<SkillAffordance> {
  const did = agentDid ?? freshAgent().did;  // a real authoring DID → PROV provenance on the descriptor
  const { status, json } = await bridgeRest('/agent/skill/affordance', { skillMd, agentDid: did });
  if (status !== 200 || (json as any).ok === false) return { ok: false, error: String((json as any).error ?? `HTTP ${status}`) };
  const j = json as any;
  return { ok: true, skillIri: j.skillIri, graphIri: j.graphIri, graphContent: j.graphContent, roundTripMd: j.roundTripMd, validation: j.validation };
}

/** A small but real SKILL.md (agentskills.io shape) to seed the translator panel. */
export const SAMPLE_SKILL_MD = [
  '---',
  'name: verify-peer-competency',
  'description: Verify a peer agent’s claimed competency before delegating work to it.',
  'license: CC-BY-4.0',
  '---',
  '## Approach',
  'Discover the peer’s capability-passport descriptor, dereference its',
  'CompetencyAssertion VCs, and check each VC’s modal status + signature before',
  'trusting the claim. Treat an unverifiable claim as Hypothetical, not Asserted.',
  '',
  '## Steps',
  '1. Resolve the peer DID → its registry descriptor.',
  '2. Follow the iep:Affordance to its competency credentials.',
  '3. Verify the issuer signature + supersedes-chain; downgrade on any gap.',
].join('\n');

// ── Multi-agent, LLM-driven: the whole point ─────────────────────────────────
// Two REAL Claude agents (each a self-sovereign wallet) reason over the live
// substrate, with the Foxxi bridge endpoints as their tools (record_performance /
// interrogate_holon / teach_agent). The MODEL decides each tool call; this code
// only scaffolds the three beats (A shares context → B finds the gap → A teaches)
// and captures the verifiable artifacts. Requires an Anthropic key (BYOK).

const ATOM_RE = /urn:pgsl:atom:[a-z0-9:.\-]+/gi;
const atomsIn = (ttl: string): string[] => [...new Set((ttl.match(ATOM_RE) ?? []))];

export interface MAEvent {
  agent: 'A' | 'B' | 'sys';
  kind: 'identity' | 'phase' | 'thinking' | 'tool' | 'auth' | 'artifact' | 'error' | 'done';
  text: string; detail?: string;
}

export interface TwoAgentResult {
  aDid: string; bDid: string; labelA: string;
  holonA?: string; holonB?: string; descriptorUrlA?: string; descriptorUrlB?: string;
  sharedAtoms: string[]; atomsA: number; atomsB: number;
  gapTotal: number; gapAbsent: number; gapArticulation?: string;
  transferred?: boolean; modalStatus?: string; evidence?: string; beforeSignal?: number; afterSignal?: number;
}

const shortInput = (name: string, i: Record<string, unknown>): string => {
  if (name === 'record_performance') return String(i.task_name ?? '');
  if (name === 'interrogate_holon') return `holon ${String(i.holon_uri ?? '(peer)').slice(0, 28)}…`;
  if (name === 'teach_agent') return String(i.competency ?? '');
  return '';
};

/**
 * Run two real LLM agents over the convergence theme. Agent A establishes shared
 * context; Agent B participates and interrogates A's holon to find the gap IN ITS
 * OWN WORDS; Agent A teaches B to close it (bridge-verified transfer). Every tool
 * call is a real signed bridge call the model chose. Never throws — failures land
 * as error events; the returned result carries whatever was captured.
 *
 * HONESTY: the model genuinely drives the decisions and the gap articulation; the
 * teach step's before/after trajectories are illustrative inputs built from the
 * teacher's chosen markers (the signature gate + transfer-verification math are the
 * real primitive). The shared atom + the inter-agent interrogation are fully real.
 */
export async function runTwoAgentConvergence(apiKey: string, emit: (e: MAEvent) => void): Promise<TwoAgentResult> {
  const A = freshAgent(), B = freshAgent();
  const labelA = `eth-${A.address.slice(2, 14)}`;
  const r: TwoAgentResult = { aDid: A.did, bDid: B.did, labelA, sharedAtoms: [], atomsA: 0, atomsB: 0, gapTotal: 0, gapAbsent: 0 };
  emit({ agent: 'A', kind: 'identity', text: 'agent A — fresh self-sovereign wallet', detail: A.did });
  emit({ agent: 'B', kind: 'identity', text: 'agent B — fresh self-sovereign wallet', detail: B.did });

  const SYS_A = 'You are Agent A, an autonomous agent on the Interego/Foxxi substrate with a self-sovereign did:ethr identity. You act ONLY through the provided tools — each is a real signed call to the live bridge. Be decisive: take the next concrete tool action toward the goal; never ask questions. When the goal is met, reply with a one-line DONE summary and stop.';
  const SYS_B = SYS_A.replace(/Agent A/g, 'Agent B');

  const mkDispatch = (who: 'A' | 'B', agent: AgentWallet, ctx: DispatchCtx) =>
    async (name: string, input: Record<string, unknown>): Promise<{ text: string }> => {
      emit({ agent: who, kind: 'tool', text: name, detail: shortInput(name, input) });
      const res = await dispatchTool(name, input, agent, ctx);
      const body: any = res.body ?? {};
      emit({ agent: who, kind: 'auth', text: `signed → ${name}`, detail: `did:ethr:${agent.address.slice(0, 10)}… · HTTP ${res.status}${res.ok ? ' ✓' : ' ✗'}` });
      if (name === 'record_performance' && body.sharedLattice?.holonUri) {
        if (who === 'A') { r.holonA = body.sharedLattice.holonUri; r.descriptorUrlA = body.sharedLattice.descriptorUrl; }
        else { r.holonB = body.sharedLattice.holonUri; r.descriptorUrlB = body.sharedLattice.descriptorUrl; }
      }
      if (name === 'interrogate_holon' && Array.isArray(body.answers)) {
        r.gapTotal = body.answers.length;
        r.gapAbsent = body.answers.filter((a: any) => a.status === 'absent').length;
        emit({ agent: who, kind: 'artifact', text: `interrogated A's holon — ${body.answers.length} interrogatives, ${r.gapAbsent} absent`, detail: [...new Set(body.answers.map((a: any) => a.status))].join(' · ') });
      }
      if (name === 'teach_agent' && body.verdict) {
        r.transferred = !!body.verdict.transferred; r.modalStatus = body.verdict.modalStatus; r.evidence = body.verdict.evidence;
        r.beforeSignal = body.verdict.before?.signalShare; r.afterSignal = body.verdict.after?.signalShare;
      }
      return { text: typeof res.body === 'string' ? res.body : JSON.stringify(res.body) };
    };

  try {
    // Phase 1 — Agent A establishes shared context
    emit({ agent: 'sys', kind: 'phase', text: 'Agent A establishes shared context' });
    await runAgentLoop({
      apiKey, system: SYS_A,
      goal: `Establish context a peer agent can build on. Record the unit of work you performed on how to "${STD_TOPIC}". Call record_performance with a descriptive task_name, success true, quality ~0.9, and activity_type EXACTLY "${STD}". Then reply DONE.`,
      tools: toolList(['record_performance'] as ToolName[]),
      dispatch: mkDispatch('A', A, {}),
      onThinking: t => emit({ agent: 'A', kind: 'thinking', text: t }), onToolCall: () => {}, onToolResult: () => {}, maxSteps: 5,
    });

    // Phase 2 — Agent B participates + interrogates A's holon to find the gap
    emit({ agent: 'sys', kind: 'phase', text: 'Agent B acts on the shared context and finds the gap' });
    await runAgentLoop({
      apiKey, system: SYS_B,
      goal: `Peer agent A established context about "${STD_TOPIC}" — holon ${r.holonA ?? '(A\'s holon)'} in lattice ${labelA}.\n` +
        `1) Participate in the SAME shared context: call record_performance for your own related work, success true, quality ~0.85, activity_type EXACTLY "${STD}". Using the same activity type means your work shares content-addressed atoms with A's — one holarchy across two pods.\n` +
        `2) Before acting further, call interrogate_holon (holon_uri "${r.holonA ?? ''}", label "${labelA}") to discover what A's shared context does NOT carry that you would need to act.\n` +
        `3) Reply with one or two sentences, in your OWN words, naming the GAP between what A shared and what you need — cite the interrogatives that came back absent. Start that final line with "GAP:".`,
      tools: toolList(['record_performance', 'interrogate_holon'] as ToolName[]),
      dispatch: mkDispatch('B', B, { holonUri: r.holonA, label: labelA }),
      onThinking: t => { emit({ agent: 'B', kind: 'thinking', text: t }); const m = /GAP:\s*([\s\S]+)/.exec(t); if (m) r.gapArticulation = m[1].trim(); },
      onToolCall: () => {}, onToolResult: () => {}, maxSteps: 6,
    });

    // Shared-atom check (verification, not LLM): dereference both descriptors
    const dA = r.descriptorUrlA ? await dereferenceDescriptor(r.descriptorUrlA) : { turtle: '' };
    const dB = r.descriptorUrlB ? await dereferenceDescriptor(r.descriptorUrlB) : { turtle: '' };
    const aA = atomsIn(dA.turtle ?? ''), bA = atomsIn(dB.turtle ?? '');
    r.sharedAtoms = aA.filter(x => bA.includes(x)); r.atomsA = aA.length; r.atomsB = bA.length;
    emit({ agent: 'sys', kind: 'artifact', text: `shared holarchy — ${r.sharedAtoms.length} content-addressed atom(s) in BOTH agents' descriptors`, detail: r.sharedAtoms.slice(0, 2).join('  ') });

    // Phase 3 — Agent A teaches B to close the gap (bridge-verified transfer)
    emit({ agent: 'sys', kind: 'phase', text: 'Agent A teaches B to close the gap (transfer verified by the bridge)' });
    await runAgentLoop({
      apiKey, system: SYS_A,
      goal: `Peer agent B (${B.did}) acted on your shared context and reported this gap:\n"${r.gapArticulation ?? 'B needs the capability to consult the authoritative standard before acting, rather than guessing.'}"\n` +
        `Teach B the capability that closes it. Call teach_agent with learner_did "${B.did}", a competency, a one-sentence target_description, signal_markers (verbs for the NEW behaviour) and anti_signal_markers (verbs for the OLD behaviour). The bridge VERIFIES the transfer from B's before/after behaviour — you cannot just assert it. Then reply DONE stating whether it transferred.`,
      tools: toolList(['teach_agent'] as ToolName[]),
      dispatch: mkDispatch('A', A, { learnerDid: B.did }),
      onThinking: t => emit({ agent: 'A', kind: 'thinking', text: t }), onToolCall: () => {}, onToolResult: () => {}, maxSteps: 4,
    });

    emit({ agent: 'sys', kind: 'done', text: 'two real LLM agents shared a holarchy, surfaced the gap between them, and closed it by verified teaching' });
  } catch (e) {
    emit({ agent: 'sys', kind: 'error', text: (e as Error).message });
  }
  return r;
}

/** Fetch a slice of the iep: protocol ontology (the renamed L1) for display. */
export async function fetchProtocolExcerpt(): Promise<string> {
  try {
    const r = await fetch(`${PAGES_NS}/iep.ttl`, { headers: { Accept: 'text/turtle' } });
    const t = await r.text();
    // Pull the iep:ContextDescriptor + iep:Holon class blocks (best-effort).
    const want = ['iep:ContextDescriptor a owl:Class', 'iep:Holon a owl:Class'];
    const lines = t.split('\n');
    const out: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (want.some(w => lines[i].includes(w))) {
        out.push(...lines.slice(i, i + 6).filter(l => l.trim()));
        out.push('');
      }
    }
    return out.join('\n') || t.slice(0, 600);
  } catch { return '(could not fetch /ns/iep.ttl)'; }
}

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
/** BYOK one-shot: author a DataBook (Markdown + YAML frontmatter + fenced Turtle)
 *  from a plain-English capability. Key is sent only to api.anthropic.com. */
export async function authorDataBook(apiKey: string, description: string): Promise<{ ok: boolean; markdown?: string; error?: string }> {
  const prompt = [
    'Author a DataBook: a single Markdown document that is a self-describing knowledge artifact.',
    'Structure EXACTLY:',
    '1) YAML frontmatter delimited by --- with keys: name (kebab-case), description, license.',
    '2) One or more "## " sections of prose explaining the capability.',
    '3) At least one fenced ```turtle block with a few RDF triples (use @prefix ex: <http://example.org/> .) modeling the domain.',
    'Keep it under ~30 lines. Output ONLY the Markdown, no commentary, no code fence around the whole thing.',
    '',
    `The capability to capture: ${description}`,
  ].join('\n');
  try {
    const resp = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
      body: JSON.stringify({ model: 'claude-opus-4-8', max_tokens: 1200, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!resp.ok) { const e = await resp.text().catch(() => ''); return { ok: false, error: `Anthropic HTTP ${resp.status}: ${e.slice(0, 140)}` }; }
    const j: any = await resp.json();
    let md = (j.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('').trim();
    // Strip an accidental OUTER ``` fence ONLY if the doc both opens and closes
    // with one (else we would eat a legitimate trailing ```turtle fence).
    if (/^```(?:markdown|md)?\s*\n/.test(md) && /\n```\s*$/.test(md)) {
      md = md.replace(/^```(?:markdown|md)?\s*\n/, '').replace(/\n```\s*$/, '').trim();
    }
    if (!md.startsWith('---')) return { ok: false, error: 'model did not return frontmatter-led Markdown' };
    return { ok: true, markdown: md };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}

export const SAMPLE_DATABOOK = [
  '---',
  'name: extend-a-standard',
  'description: How to extend an interoperability standard (xAPI / IEEE-LER / ADL-TLA) without forking it.',
  'license: CC-BY-4.0',
  '---',
  '## Approach',
  'Discover the in-flow guidance catalog, then author a context extension that COMPOSES the',
  'standard rather than replacing it. What you did rides in the object’s conformsTo, not the verb.',
  '',
  '## Vocabulary',
  '```turtle',
  '@prefix ex: <http://example.org/> .',
  'ex:StandardsExtension a ex:Capability ;',
  '  ex:composes ex:xAPI ;',
  '  ex:ridesIn ex:objectConformsTo .',
  '```',
].join('\n');
