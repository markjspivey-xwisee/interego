/**
 * Babel — two LLM agents with DIFFERENT private vocabularies converge on a shared
 * sign-system, and we MEASURE the convergence as content-addressed atom fusion.
 *
 * Each agent coins its OWN word for the same work and records it — byte-different
 * words → byte-different `urn:pgsl:atom` hashes → they share NOTHING for the concept
 * (only incidental atoms like the activity type + verb). They then NEGOTIATE one
 * canonical word (irreducibly linguistic — this is why real LLMs are the point),
 * adopt it, and re-record: the moment both use the byte-identical string, the
 * concept atom FUSES and the shared-atom set grows. Meaning-as-use, proven as sha256
 * the model cannot fake.
 *
 * Ground-truth-probed: synonym words share 2 incidental atoms; adopting the exact
 * word adds exactly 1 shared atom (the coined word). Honest: content-addressing
 * rewards byte-identity and preserves near-synonyms as DISTINCT — a feature, stated.
 */
import { ethers } from 'ethers';
import { freshAgent, postSigned, type AgentWallet } from './agent-signing.js';
import { dispatchTool, toolList, type ToolName } from './agent-tools.js';
import { runAgentLoop } from './anthropic-runner.js';

const STD = 'https://markjspivey-xwisee.github.io/interego/applications/agentic-performance-practice/agp#StandardsExtension';
const CONCEPT = 'the act of re-checking your own work against an authoritative reference before you commit to it';

export type BabelKind = 'identity' | 'phase' | 'reasoning' | 'coin' | 'measure' | 'negotiate' | 'fuse' | 'done' | 'error';
export interface BabelEvent { id: number; actor: 'Agent A' | 'Agent B' | 'sys'; kind: BabelKind; title: string; detail?: string; ts: string }
let counter = 0;
export function makeEmit(push: (e: BabelEvent) => void) { return (e: Omit<BabelEvent, 'id' | 'ts'>) => push({ ...e, id: counter++, ts: new Date().toISOString() }); }
export function resetCounter() { counter = 0; }

export interface BabelResult { wordA?: string; wordB?: string; agreedWord?: string; sharedBefore: number; sharedAfter: number; fusedAtom?: string; descriptorA?: string; descriptorB?: string; converged: boolean }

const ATOM_RE = /urn:pgsl:atom:[a-z0-9:.\-]+/gi;
async function atomsOf(url?: string): Promise<string[]> { if (!url) return []; try { const r = await fetch(url, { headers: { Accept: 'text/turtle' } }); const t = await r.text(); return [...new Set((t.match(ATOM_RE) ?? []))]; } catch { return []; } }
const SYS = (who: string) => `You are ${who}, an autonomous agent on the Interego/Foxxi substrate with a self-sovereign did:ethr identity. You act through the provided tools (real signed calls to the live bridge). Be decisive; never ask questions.`;

export async function runBabel(apiKey: string, emit: (e: Omit<BabelEvent, 'id' | 'ts'>) => void): Promise<BabelResult> {
  const A = freshAgent(), B = freshAgent();
  emit({ actor: 'Agent A', kind: 'identity', title: 'Agent A — its own private vocabulary', detail: A.did });
  emit({ actor: 'Agent B', kind: 'identity', title: 'Agent B — a different private vocabulary', detail: B.did });
  const r: BabelResult = { sharedBefore: 0, sharedAfter: 0, converged: false };

  // capture the coined word (tool input) + the descriptor (tool result) per agent
  const coinDispatch = (cap: { word?: string; url?: string }, agent: AgentWallet) =>
    async (name: string, input: Record<string, unknown>): Promise<{ text: string }> => {
      if (name === 'record_performance' && typeof input.task_name === 'string') cap.word = input.task_name;
      const res = await dispatchTool(name, input, agent, {});
      const sl = (res.body as any)?.sharedLattice;
      if (name === 'record_performance' && sl?.descriptorUrl) cap.url = sl.descriptorUrl;
      return { text: typeof res.body === 'string' ? res.body : JSON.stringify(res.body) };
    };

  async function coin(agent: AgentWallet, who: 'Agent A' | 'Agent B'): Promise<{ word?: string; url?: string }> {
    const cap: { word?: string; url?: string } = {};
    emit({ actor: who, kind: 'phase', title: `${who} coins its own word for the concept` });
    await runAgentLoop({
      apiKey, system: SYS(who),
      goal: `Coin a SINGLE short, distinctive word or two-word phrase — in your OWN private vocabulary — for this concept:\n"${CONCEPT}"\nDo NOT use generic dictionary words like "verify" or "review"; invent or choose YOUR idiosyncratic term. Then call record_performance with task_name set to EXACTLY your coined term, success true, quality 1, activity_type "${STD}". Reply DONE with your term.`,
      tools: toolList(['record_performance'] as ToolName[]),
      dispatch: coinDispatch(cap, agent),
      onThinking: t => emit({ actor: who, kind: 'reasoning', title: 'reasoning', detail: t }), onToolCall: () => {}, onToolResult: () => {}, maxSteps: 4,
    });
    emit({ actor: who, kind: 'coin', title: `coined: "${cap.word ?? '(none)'}"`, detail: cap.url });
    return cap;
  }

  const ca = await coin(A, 'Agent A'); r.wordA = ca.word; r.descriptorA = ca.url;
  const cb = await coin(B, 'Agent B'); r.wordB = cb.word; r.descriptorB = cb.url;

  // baseline: do their sign-systems line up?
  const aA0 = await atomsOf(ca.url), aB0 = await atomsOf(cb.url);
  const shared0 = aA0.filter(x => aB0.includes(x));
  r.sharedBefore = shared0.length;
  emit({ actor: 'sys', kind: 'measure', title: `before negotiation: ${shared0.length} shared atom(s) — and NONE is the concept`, detail: `A "${r.wordA}" and B "${r.wordB}" are byte-different → distinct content-addressed atoms; the ${shared0.length} shared are incidental (activity type + verb)` });

  // negotiate one canonical word (the irreducibly linguistic step)
  emit({ actor: 'sys', kind: 'phase', title: 'The agents negotiate a shared sign' });
  const proposal = await oneShot(apiKey, `Two agents coined different private words for the same concept ("${CONCEPT}"). Agent A's word: "${r.wordA}". Agent B's word: "${r.wordB}". Speaking AS Agent A, propose ONE shared canonical word/phrase both should adopt (it may be A's, B's, or a blend). Output exactly: PROPOSE: <word>`);
  const proposed = (/PROPOSE:\s*(.+)/i.exec(proposal)?.[1] || r.wordA || '').trim().replace(/^["']|["']$/g, '');
  emit({ actor: 'Agent A', kind: 'negotiate', title: `proposes a shared word: "${proposed}"` });
  const decision = await oneShot(apiKey, `Speaking AS Agent B (your word was "${r.wordB}"), Agent A proposes you both adopt "${proposed}" for the concept "${CONCEPT}". Accept it, or counter with a different shared word. Output exactly: AGREE: <the single word you both will use>`);
  const agreed = (/AGREE:\s*(.+)/i.exec(decision)?.[1] || proposed).trim().replace(/^["']|["']$/g, '');
  r.agreedWord = agreed;
  emit({ actor: 'Agent B', kind: 'negotiate', title: `agrees on: "${agreed}"`, detail: 'a shared sign, reached by use — not assigned' });

  // adopt: BOTH re-record using the byte-identical agreed word → the concept atom fuses
  emit({ actor: 'sys', kind: 'phase', title: 'Both adopt the agreed word — watch the atom fuse' });
  const reA = (await postSigned('/agent/record-performance', A, { task_name: agreed, success: true, quality: 1, activity_type: STD })).body as any;
  const reB = (await postSigned('/agent/record-performance', B, { task_name: agreed, success: true, quality: 1, activity_type: STD })).body as any;
  const urlA = reA?.sharedLattice?.descriptorUrl, urlB = reB?.sharedLattice?.descriptorUrl;
  r.descriptorA = urlA ?? r.descriptorA; r.descriptorB = urlB ?? r.descriptorB;
  const aA1 = await atomsOf(urlA), aB1 = await atomsOf(urlB);
  const shared1 = aA1.filter(x => aB1.includes(x));
  r.sharedAfter = shared1.length;
  r.fusedAtom = shared1.find(x => !shared0.includes(x));
  r.converged = shared1.length > shared0.length;
  emit({ actor: 'sys', kind: 'fuse', title: r.converged ? `after adoption: ${shared1.length} shared atom(s) — the concept word FUSED` : `after adoption: ${shared1.length} shared (no new fusion this run)`, detail: r.fusedAtom ? `new shared atom (the agreed word "${agreed}"): ${r.fusedAtom}` : undefined });
  emit({ actor: 'sys', kind: 'done', title: r.converged ? `convergence measured: ${shared0.length} → ${shared1.length} shared atoms` : 'no new convergence this run (content-addressing rewards exact byte-identity)' });
  return r;
}

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
async function oneShot(apiKey: string, prompt: string): Promise<string> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const resp = await fetch(ANTHROPIC_URL, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' }, body: JSON.stringify({ model: 'claude-opus-4-8', max_tokens: 300, messages: [{ role: 'user', content: prompt }] }) });
    if (resp.ok) { const j: any = await resp.json(); return (j.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('').trim(); }
    if ((resp.status === 429 || resp.status === 529 || resp.status >= 500) && attempt < 3) { await new Promise(res => setTimeout(res, Math.min(8000, 600 * 2 ** attempt))); continue; }
    const t = await resp.text().catch(() => ''); throw new Error(`Anthropic ${resp.status}: ${t.slice(0, 160)}`);
  }
  throw new Error('Anthropic: exhausted retries');
}
