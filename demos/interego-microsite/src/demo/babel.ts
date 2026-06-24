/**
 * Babel — two LLM agents converge on a shared sign-system, measured as PGSL atom
 * fusion ON THE SUBSTRATE (no vertical). Each coins its OWN word and content-
 * addresses it via `protocol.pgsl_mint_atom` → byte-different words → different
 * `urn:pgsl:atom` IRIs → `protocol.pgsl_meet` shows 0 shared for the concept. They
 * negotiate one canonical word (real LLM dialogue), both mint it, and the meet now
 * finds 1 shared atom — fusion, by content-addressing the model can't fake.
 */
import { callTool } from '../lib/bridge.js';
import { oneShot } from '../lib/anthropic.js';

const CONCEPT = 'the act of re-checking your own work against an authoritative reference before you commit to it';

// The two agents have GENUINELY different private idiolects, so they coin DIFFERENT
// words from the same concept (otherwise the same prompt → same model → same word, and
// there is no divergence to converge from). Each agent's coinage is its OWN oneShot
// output, minted from its own bytes — fusion only happens if they truly land together.
const VOICE: Record<'Agent A' | 'Agent B', string> = {
  'Agent A': 'Your private idiolect is terse and Latinate: you build compact, technical coinages from Latin/Greek roots (suffixes like -ation, -ity, -or; neo-compounds). You never use plain everyday English.',
  'Agent B': 'Your private idiolect is plain and Germanic: you build earthy, metaphorical everyday-English coinages and short compounds from concrete imagery. You never use Latinate or academic-sounding words.',
};

export type BabelKind = 'identity' | 'phase' | 'coin' | 'measure' | 'negotiate' | 'fuse' | 'done' | 'error';
export interface BabelEvent { id: number; actor: 'Agent A' | 'Agent B' | 'sys'; kind: BabelKind; title: string; detail?: string; ts: string }
let counter = 0;
export function makeEmit(push: (e: BabelEvent) => void) { return (e: Omit<BabelEvent, 'id' | 'ts'>) => push({ ...e, id: counter++, ts: new Date().toISOString() }); }
export function resetCounter() { counter = 0; }
export interface BabelResult { wordA?: string; wordB?: string; agreedWord?: string; sharedBefore: number; sharedAfter: number; fusedAtom?: string; converged: boolean }

async function mint(value: string): Promise<string> { const r = await callTool('protocol.pgsl_mint_atom', { value }); return r.atom_iri; }
async function meet(a: string[], b: string[]): Promise<{ count: number; shared: string[] }> { const r = await callTool('protocol.pgsl_meet', { atom_iris_a: a, atom_iris_b: b }); return { count: r.shared_atom_count ?? 0, shared: (r.shared_atoms ?? []).map((x: any) => x.iri) }; }

export async function runBabel(apiKey: string, emit: (e: Omit<BabelEvent, 'id' | 'ts'>) => void): Promise<BabelResult> {
  const r: BabelResult = { sharedBefore: 0, sharedAfter: 0, converged: false };
  emit({ actor: 'Agent A', kind: 'identity', title: 'Agent A — its own private vocabulary' });
  emit({ actor: 'Agent B', kind: 'identity', title: 'Agent B — a different private vocabulary' });

  async function coin(who: 'Agent A' | 'Agent B'): Promise<{ word: string; atom: string }> {
    emit({ actor: who, kind: 'phase', title: `${who} coins its own word` });
    let word = '';
    try {
      const out = await oneShot(apiKey, `You are ${who}, an agent with a private vocabulary. ${VOICE[who]}\nCoin ONE short, distinctive term — in YOUR idiolect — for this concept:\n"${CONCEPT}"\nIt must sound like YOUR voice and unlike a generic dictionary word ("verify", "review"). Output ONLY the term, nothing else.`);
      word = out.split('\n')[0].replace(/^["']|["'.]+$/g, '').trim().slice(0, 60) || `term-${Math.random().toString(36).slice(2, 7)}`;
    } catch (e) { emit({ actor: who, kind: 'error', title: (e as Error).message }); word = `term-${Math.random().toString(36).slice(2, 7)}`; }
    const atom = await mint(word);
    emit({ actor: who, kind: 'coin', title: `coined "${word}"`, detail: atom });
    return { word, atom };
  }

  const a = await coin('Agent A'); r.wordA = a.word;
  const b = await coin('Agent B'); r.wordB = b.word;

  const before = await meet([a.atom], [b.atom]);
  r.sharedBefore = before.count;
  emit({ actor: 'sys', kind: 'measure', title: `before negotiation: ${before.count} shared atom(s)`, detail: `"${r.wordA}" and "${r.wordB}" are byte-different → distinct content-addressed atoms` });

  emit({ actor: 'sys', kind: 'phase', title: 'The agents negotiate a shared sign' });
  let agreed = a.word;
  try {
    const prop = await oneShot(apiKey, `Two agents coined different private words for the same concept ("${CONCEPT}"). Agent A: "${r.wordA}". Agent B: "${r.wordB}". Speaking AS Agent A, propose ONE shared word both should adopt (A's, B's, or a blend). Output: PROPOSE: <word>`);
    const proposed = (/PROPOSE:\s*(.+)/i.exec(prop)?.[1] || r.wordA || '').trim().replace(/^["']|["'.]+$/g, '');
    emit({ actor: 'Agent A', kind: 'negotiate', title: `proposes "${proposed}"` });
    const dec = await oneShot(apiKey, `Speaking AS Agent B (your word was "${r.wordB}"), Agent A proposes you both adopt "${proposed}". Accept, or counter. Output: AGREE: <the single word you both will use>`);
    agreed = (/AGREE:\s*(.+)/i.exec(dec)?.[1] || proposed).trim().replace(/^["']|["'.]+$/g, '') || proposed;
  } catch (e) { emit({ actor: 'sys', kind: 'error', title: (e as Error).message }); }
  emit({ actor: 'Agent B', kind: 'negotiate', title: `agrees on "${agreed}"`, detail: 'a shared sign reached by use — not assigned' });

  // Each agent INDEPENDENTLY states + mints the word it will now use — NOT a shared JS
  // variable. Fusion is real only because both genuinely land on the same bytes; if one
  // defected to a different word, its atom would differ and nothing would fuse.
  emit({ actor: 'sys', kind: 'phase', title: 'Each agent adopts a word independently — watch the atom fuse' });
  let adoptA = agreed, adoptB = agreed;
  try {
    adoptA = (await oneShot(apiKey, `Speaking AS Agent A: you negotiated to adopt "${agreed}". Output ONLY the exact single term you will now use in your records — nothing else.`)).split('\n')[0].replace(/^["']|["'.]+$/g, '').trim().slice(0, 60) || agreed;
    adoptB = (await oneShot(apiKey, `Speaking AS Agent B: you negotiated to adopt "${agreed}". Output ONLY the exact single term you will now use in your records — nothing else.`)).split('\n')[0].replace(/^["']|["'.]+$/g, '').trim().slice(0, 60) || agreed;
  } catch (e) { emit({ actor: 'sys', kind: 'error', title: (e as Error).message }); }
  r.agreedWord = adoptA === adoptB ? adoptA : `${adoptA} / ${adoptB}`;
  const aAgreed = await mint(adoptA);   // Agent A mints the word IT adopted
  const bAgreed = await mint(adoptB);   // Agent B mints the word IT adopted — fuse iff identical bytes
  const after = await meet([a.atom, aAgreed], [b.atom, bAgreed]);
  r.sharedAfter = after.count;
  r.fusedAtom = after.shared.find(x => x !== a.atom && x !== b.atom) ?? after.shared[0];
  r.converged = after.count > before.count;
  emit({ actor: 'sys', kind: 'fuse', title: r.converged ? `after adoption: ${after.count} shared atom(s) — the concept word FUSED` : `after adoption: ${after.count} shared — adopted bytes differ, no fusion`, detail: r.converged && r.fusedAtom ? `both adopted "${adoptA}" → ${r.fusedAtom}` : `Agent A → "${adoptA}", Agent B → "${adoptB}"` });
  emit({ actor: 'sys', kind: 'done', title: r.converged ? `convergence measured on the substrate: ${before.count} → ${after.count} shared atoms` : 'no new convergence this run' });
  return r;
}
