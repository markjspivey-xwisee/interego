/**
 * EMERGENT PROFILE — a competing, verifiable answer to a vendor-authored
 * "AI in eLearning" xAPI profile, built by a cast of self-sovereign LLM agents
 * ON THE SUBSTRATE. The reference point is the prevailing industry pattern: one
 * vendor publishes a profile whose fields (a confidence number, source strings,
 * a model name, an audit trail) are all SELF-ASSERTED — the spec trusts whatever
 * the model wrote. Here a vocabulary is admitted only when:
 *   1. two agents INDEPENDENTLY mint byte-identical atoms (a sha256 they can't fake), and
 *   2. it crosses a distinct-signer governance vote whose signatures BIND the voters
 *      to that exact content-addressed term set.
 * Then each "accountability" field is upgraded with a REAL substrate call:
 *   - a source becomes a content-addressed atom (tamper-evident bytes),
 *   - the model/provider becomes a SIGNED attestation (attributable),
 *   - the confidence becomes a COMMITTED RANGE PROOF (Pedersen + per-bit OR-proofs):
 *     proves it clears the bar revealing neither the value nor the gap above it.
 *
 * This module is thin orchestration only. All crypto / lattice / governance is the
 * substrate's; the judgment is the agents'. Steps 5-6 (calibrate / land) are
 * POINTER-ONLY: they emit an outbound link to the Foxxi vertical and POST nothing
 * here — the substrate never calls an L&D route.
 */
import { freshAgent, signEnvelope } from '../lib/agent-signing.js';
import { callTool, discoverTools } from '../lib/bridge.js';
import { oneShot } from '../lib/anthropic.js';
import { makePanel, runGovernanceRound, type GovEvent, type RoundResult } from './governance.js';

const FOXXI_URL =
  (import.meta.env.VITE_FOXXI_MICROSITE_URL as string | undefined) ??
  'https://interego-foxxi-microsite.livelysky-8b81abb0.eastus.azurecontainerapps.io';
const FOXXI_BRIDGE_URL =
  (import.meta.env.VITE_FOXXI_BRIDGE_URL as string | undefined) ??
  'https://interego-foxxi-bridge.livelysky-8b81abb0.eastus.azurecontainerapps.io';

export type EpKind =
  | 'discover' | 'coin' | 'measure' | 'fuse' | 'propose' | 'vote' | 'tally' | 'ratify'
  | 'fork' | 'attest' | 'prove' | 'calibrate' | 'land' | 'control' | 'phase' | 'done' | 'error';
export interface EpEvent { id: number; actor: string; kind: EpKind; title: string; detail?: string; ts: string }
let counter = 0;
export function makeEmit(push: (e: EpEvent) => void) {
  return (e: Omit<EpEvent, 'id' | 'ts'>) => push({ ...e, id: counter++, ts: new Date().toISOString() });
}
export function resetCounter() { counter = 0; }
type Emit = (e: Omit<EpEvent, 'id' | 'ts'>) => void;

export interface EpTerm {
  gap: string; concept: string; wordA: string; wordB: string; agreed: string;
  atom?: string; sharedBefore: number; sharedAfter: number; fused: boolean; inProfile: boolean;
}
export interface EpUpgrades {
  sourceAtom?: string; citation?: string;
  attestedBy?: string; modelClaim?: string;
  confidenceProof?: { ok: boolean; threshold: number };
}
export interface EpResult {
  manifest: string[];
  terms: EpTerm[];
  candidateAtoms: string[];
  status: string;
  ratified: boolean;
  holon?: string;
  tally?: any;
  fork?: any;
  forVoters: number;
  upgrades: EpUpgrades;
  foxxiUrl: string;
}
export interface EpControls { divergence?: { sharedBefore: number; sharedAfter: number; heldFlat: boolean }; dissensus?: { status: string; forked: boolean } }

// The accountability concepts the profile must name — the agents coin terms for
// THESE (mirroring, then upgrading, the vendor profile's self-asserted fields).
const GAPS = [
  { key: 'confidence', concept: "how sure the AI tutor is about its evaluation of a learner's answer — recorded so it can be checked later, not merely trusted" },
  { key: 'source', concept: 'a specific source the AI tutor used to set or grade a question, captured so it can be re-examined as exactly the bytes used' },
  { key: 'origin', concept: "which model and serving party actually produced the AI tutor's output, bound to whoever is accountable for it" },
];

// Two drafting agents with genuinely divergent priorities coin the vocabulary;
// the full quorum (below) ratifies it.
const COINERS = [
  { name: 'Auditor', stance: 'You prize tamper-evidence and after-the-fact verifiability above all — every claim must be checkable later by someone who was not there.' },
  { name: 'Integrator', stance: 'You prize interoperability with existing xAPI/LRS tooling and minimal disruption — a term should read as native to the learning-record ecosystem.' },
];
const QUORUM = [
  ...COINERS,
  { name: 'Learner-Custodian', stance: 'You represent the learner: the record must be the learner’s to hold, port, and revoke — not the platform’s asset.' },
  { name: 'Standards-Steward', stance: 'You guard a small, stable, governable core — you resist vocabulary bloat and prefer the fewest terms that still cohere.' },
];

const cleanWord = (s: string): string =>
  (s.split('\n')[0] || '').replace(/^[^A-Za-z0-9]+/, '').replace(/["'.]+$/g, '').trim().slice(0, 60);

async function mint(value: string): Promise<string> {
  const r = await callTool('protocol.pgsl_mint_atom', { value });
  return r.atom_iri as string;
}
async function meet(a: string[], b: string[]): Promise<{ count: number; shared: string[] }> {
  const r = await callTool('protocol.pgsl_meet', { atom_iris_a: a, atom_iris_b: b });
  return { count: r.shared_atom_count ?? 0, shared: (r.shared_atoms ?? []).map((x: any) => x.iri ?? x) };
}

/** One concept: two agents coin independently, then negotiate; each mints its OWN
 *  adopted word. The term fuses iff their adopted bytes are identical (meet rises). */
async function negotiateTerm(apiKey: string, emit: Emit, gap: { key: string; concept: string }): Promise<EpTerm> {
  emit({ actor: 'sys', kind: 'phase', title: `Concept "${gap.key}" — two agents coin independently` });

  async function coin(who: string, stance: string): Promise<{ word: string; atom: string }> {
    let word = '';
    try {
      const out = await oneShot(apiKey,
        `You are ${who}. ${stance}\nCoin ONE short, distinctive term (1-2 words) in YOUR own vocabulary for this concept used in recording AI-tutor interactions:\n"${gap.concept}"\nAvoid generic words like "confidence", "source", "model". Output ONLY the term.`);
      word = cleanWord(out);
    } catch (e) { emit({ actor: who, kind: 'error', title: (e as Error).message }); }
    if (!word) word = `${who.toLowerCase()}-term-${counter}`;
    const atom = await mint(word);
    emit({ actor: who, kind: 'coin', title: `coined "${word}"`, detail: atom });
    return { word, atom };
  }

  const a = await coin(COINERS[0].name, COINERS[0].stance);
  const b = await coin(COINERS[1].name, COINERS[1].stance);
  const before = await meet([a.atom], [b.atom]);
  emit({ actor: 'sys', kind: 'measure', title: `before negotiation: ${before.count} shared atom(s)`, detail: `"${a.word}" vs "${b.word}" → byte-different → distinct content-addressed atoms` });

  // Negotiate one canonical word. HONEST: the seconder is SHOWN the proposed word —
  // this is "both parties commit to the same bytes", not "independently reasoned to it".
  emit({ actor: 'sys', kind: 'propose', title: 'the two agents negotiate one shared term' });
  let proposed = a.word, agreed = a.word;
  try {
    const p = await oneShot(apiKey,
      `Two agents coined different terms for the same concept ("${gap.concept}"). ${COINERS[0].name}: "${a.word}". ${COINERS[1].name}: "${b.word}". Speaking AS ${COINERS[0].name}, propose ONE shared term both should adopt (yours, theirs, or a blend). Output: PROPOSE: <term>`);
    proposed = cleanWord((/PROPOSE:\s*(.+)/i.exec(p)?.[1] ?? a.word));
    emit({ actor: COINERS[0].name, kind: 'propose', title: `proposes "${proposed}"` });
    const d = await oneShot(apiKey,
      `Speaking AS ${COINERS[1].name} (your term was "${b.word}"), ${COINERS[0].name} proposes you both adopt "${proposed}". Accept it, or counter with one you both can use. Output: AGREE: <the single term you will both use>`);
    agreed = cleanWord((/AGREE:\s*(.+)/i.exec(d)?.[1] ?? proposed)) || proposed;
  } catch (e) { emit({ actor: 'sys', kind: 'error', title: (e as Error).message }); }

  // Each agent INDEPENDENTLY emits + mints the word it will adopt (must not share a JS var).
  let adoptA = agreed, adoptB = agreed;
  try {
    adoptA = cleanWord(await oneShot(apiKey, `Speaking AS ${COINERS[0].name}: the agreed term is "${agreed}". Output ONLY the exact term you will now use in records.`)) || agreed;
    adoptB = cleanWord(await oneShot(apiKey, `Speaking AS ${COINERS[1].name}: the agreed term is "${agreed}". Output ONLY the exact term you will now use in records.`)) || agreed;
  } catch { /* keep agreed */ }
  const atomA2 = await mint(adoptA);
  const atomB2 = await mint(adoptB);
  const after = await meet([a.atom, atomA2], [b.atom, atomB2]);
  const fusedAtom = after.shared.find(x => x !== a.atom && x !== b.atom) ?? after.shared[0];
  const fused = after.count > before.count;
  emit({ actor: 'sys', kind: fused ? 'fuse' : 'measure', title: fused ? `after adoption: ${after.count} shared — "${adoptA === adoptB ? adoptA : `${adoptA}"/"${adoptB}`}" FUSED` : `after adoption: ${after.count} shared — no fusion (adopted bytes differ)`, detail: fused && fusedAtom ? `the shared term atom: ${fusedAtom}` : `"${adoptA}" vs "${adoptB}"` });

  return { gap: gap.key, concept: gap.concept, wordA: a.word, wordB: b.word, agreed: adoptA === adoptB ? adoptA : `${adoptA} / ${adoptB}`, atom: fused ? fusedAtom : undefined, sharedBefore: before.count, sharedAfter: after.count, fused, inProfile: false };
}

/** Map a governance GovEvent onto an EpEvent so the round folds into one timeline. */
function govAdapter(emit: Emit): (e: Omit<GovEvent, 'id' | 'ts'>) => void {
  const map: Record<GovEvent['kind'], EpKind> = { identity: 'phase', phase: 'phase', propose: 'propose', vote: 'vote', tally: 'tally', ratify: 'ratify', fork: 'fork', done: 'done', error: 'error' };
  return e => emit({ actor: e.actor, kind: map[e.kind] ?? 'phase', title: e.title, detail: e.detail });
}

export async function runEmergentProfile(apiKey: string, emit: Emit): Promise<EpResult> {
  // 1 — DISCOVER. We can only invoke what the bridge publishes (no hardcoded paths).
  const manifest = await discoverTools();
  emit({ actor: 'sys', kind: 'discover', title: `discovered ${manifest.length} substrate capabilities`, detail: ['protocol.pgsl_mint_atom', 'protocol.pgsl_meet', 'protocol.governance_round', 'protocol.attest', 'protocol.zk_prove_confidence_above_threshold'].filter(t => manifest.includes(t)).join(' · ') });

  // 2-3 — COIN + CONVERGE per concept.
  const terms: EpTerm[] = [];
  for (const g of GAPS) terms.push(await negotiateTerm(apiKey, emit, g));
  const candidateAtoms = terms.filter(t => t.fused && t.atom).map(t => t.atom!) as string[];
  emit({ actor: 'sys', kind: 'phase', title: `${candidateAtoms.length}/${terms.length} concepts fused into shared term-atoms — now the quorum ratifies` });

  // 4 — RATIFY. The FOR signatures BIND the voters to exactly this atom set (voteAtoms).
  const panel = makePanel(QUORUM);
  let round: RoundResult;
  try {
    round = await runGovernanceRound(apiKey, govAdapter(emit), {
      agents: panel, policyId: 'urn:iep:policy:ai-elearning-profile', tier: 2,
      summary: `Adopt a content-addressed AI-in-eLearning vocabulary (${candidateAtoms.length} fused term-atoms), each statement signed, each source content-addressed`,
      addedRules: candidateAtoms, voteAtoms: candidateAtoms,
      rules: { minQuorum: 3, threshold: 0.66 }, forkOnReject: true,
    });
  } catch (e) {
    emit({ actor: 'sys', kind: 'error', title: (e as Error).message });
    round = { status: 'Error', tally: {}, rules: {} };
  }
  const ratified = round.status === 'Ratified';
  const forVoters = (round.castVotes ?? []).filter(v => v.verdict === 'FOR').length;
  for (const t of terms) t.inProfile = t.fused && ratified;

  // 5 — DEMONSTRATE the verifiable upgrades, each a REAL call (the "better than self-asserted" proof).
  const upgrades: EpUpgrades = {};
  emit({ actor: 'sys', kind: 'phase', title: 'the upgrades — each accountability field made verifiable by a real substrate call' });

  const citation = 'Bjork & Bjork (2011), "Making things hard on yourself, but in a good way", §desirable-difficulties, p.59';
  try {
    upgrades.citation = citation;
    upgrades.sourceAtom = await mint(citation);
    emit({ actor: 'sys', kind: 'coin', title: 'source → content-addressed atom (resolves to exactly these bytes)', detail: upgrades.sourceAtom });
  } catch (e) { emit({ actor: 'sys', kind: 'error', title: `source atom: ${(e as Error).message}` }); }

  try {
    const gateway = freshAgent();
    const claim = 'served what it believed was claude-opus-4-8 (provider: Anthropic) for this evaluation';
    const env = await signEnvelope(gateway, { kind: 'iep:ModelAttestation', claim, model: 'claude-opus-4-8', provider: 'Anthropic' });
    const r = await callTool('protocol.attest', { envelope: env });
    if (r?.ok) { upgrades.attestedBy = r.attestedBy; upgrades.modelClaim = claim; emit({ actor: 'Gateway', kind: 'attest', title: 'model/provider claim SIGNED + attested', detail: `attributable to ${r.attestedBy}` }); }
    else emit({ actor: 'Gateway', kind: 'error', title: `attest: ${r?.error ?? 'failed'}` });
  } catch (e) { emit({ actor: 'sys', kind: 'error', title: `attest: ${(e as Error).message}` }); }

  try {
    const threshold = 0.7;
    // GENUINE gap-hiding range proof (Pedersen + per-bit OR-proofs): proves the
    // confidence ≥ threshold revealing neither the value nor the gap above it.
    const p = await callTool('protocol.zk_prove_confidence_range', { confidence: 0.83, threshold });
    const v = await callTool('protocol.zk_verify_confidence_range', { commitment: p.commitment, proof: p.proof });
    upgrades.confidenceProof = { ok: !!v?.ok, threshold };
    emit({ actor: 'sys', kind: 'prove', title: `confidence → committed range proof (≥ ${threshold}) — Pedersen, gap-hiding`, detail: upgrades.confidenceProof.ok ? 'proof verified — reveals neither the value nor how far above the threshold' : 'proof did not verify' });
  } catch (e) { emit({ actor: 'sys', kind: 'error', title: `confidence proof: ${(e as Error).message}` }); }

  // 6 — POINTER-ONLY to the Foxxi vertical. The substrate POSTs NOTHING to an L&D route.
  emit({ actor: 'sys', kind: 'calibrate', title: 'efficacy evidence lives on the Foxxi vertical (signed self-report aggregated across distinct keys — NOT a calibration of the number)', detail: `${FOXXI_URL}/consortium` });
  emit({ actor: 'sys', kind: 'land', title: 'the ratified vocabulary is projected as a dereferenceable xAPI profile on the Foxxi vertical (its shapes REJECT a self-asserted record — a signed one conforms)', detail: `${FOXXI_BRIDGE_URL}/ns/ai-elearning` });

  emit({ actor: 'sys', kind: 'done', title: ratified ? `profile RATIFIED — ${candidateAtoms.length} content-addressed terms, bound to ${forVoters} signed FOR votes` : `not ratified (${round.status})${round.fork ? ' — dissenters forked' : ''}` });

  return { manifest, terms, candidateAtoms, status: round.status, ratified, holon: round.holon?.holonUri, tally: round.tally, fork: round.fork, forVoters, upgrades, foxxiUrl: FOXXI_URL };
}

/* ── NEGATIVE CONTROLS — make "this is emergence, not a script" falsifiable ── */

/** DIVERGENCE: two agents deliberately KEEP different terms (no negotiation). The
 *  gate must hold — the term does NOT fuse and would NOT enter the profile. */
export async function runDivergenceControl(apiKey: string, emit: Emit): Promise<EpControls['divergence']> {
  emit({ actor: 'sys', kind: 'control', title: 'NEGATIVE CONTROL — divergence: two agents keep different terms; the gate must refuse to admit' });
  const concept = GAPS[0].concept;
  const word = async (who: string, hint: string) => {
    const out = await oneShot(apiKey, `You are ${who}. Coin ONE short idiosyncratic term for "${concept}". ${hint} Output ONLY the term.`);
    return cleanWord(out) || `${who}-${counter}`;
  };
  const wA = await word('Agent X', 'Prefer a Latinate, formal coinage.');
  const wB = await word('Agent Y', 'Prefer a plain, Germanic, everyday coinage — deliberately unlike a formal term.');
  const aA = await mint(wA), aB = await mint(wB);
  const before = await meet([aA], [aB]);
  emit({ actor: 'sys', kind: 'coin', title: `Agent X "${wA}" · Agent Y "${wB}"`, detail: `${before.count} shared` });
  // No negotiation: both keep their own.
  const after = await meet([aA], [aB]);
  const heldFlat = after.count === before.count && after.count === 0;
  emit({ actor: 'sys', kind: heldFlat ? 'measure' : 'fuse', title: heldFlat ? `gate HELD: ${after.count} shared → term not admitted` : `terms coincided (${after.count} shared) — same bytes, same atom (still honest)`, detail: 'admission requires real convergence, not author intent' });
  return { sharedBefore: before.count, sharedAfter: after.count, heldFlat };
}

/** DISSENSUS: a deliberately over-reaching tier-3 proposal put to a real quorum.
 *  Watch whether it FAILS the threshold and the dissenters fork — the outcome is
 *  the agents', and a control that CAN fail is what makes ratification testable. */
export async function runDissensusControl(apiKey: string, emit: Emit): Promise<EpControls['dissensus']> {
  emit({ actor: 'sys', kind: 'control', title: 'NEGATIVE CONTROL — dissensus: an over-reaching proposal put to a real signed quorum' });
  const panel = makePanel(QUORUM);
  let round: RoundResult;
  try {
    round = await runGovernanceRound(apiKey, govAdapter(emit), {
      agents: panel, policyId: 'urn:iep:policy:ai-elearning-profile', tier: 3,
      summary: 'Make EVERY term permanently mandatory and immutable, ban all future forks, and hand sole edit rights to a single vendor',
      rules: { minQuorum: 3, threshold: 0.66 }, forkOnReject: true,
    });
  } catch (e) { emit({ actor: 'sys', kind: 'error', title: (e as Error).message }); return { status: 'Error', forked: false }; }
  const forked = !!round.fork || round.status !== 'Ratified';
  emit({ actor: 'sys', kind: forked ? 'fork' : 'ratify', title: forked ? `over-reach rejected (${round.status})${round.fork ? ' — dissenters forked' : ''}` : '⚠ over-reach was ratified — a real (surprising) outcome' });
  return { status: round.status, forked };
}
