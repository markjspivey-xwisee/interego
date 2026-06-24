/**
 * Constitutional governance (Quorum + Constitution) on the SUBSTRATE surface.
 * A panel of real LLM agents (each a self-sovereign wallet + stance) debate an
 * amendment and each SIGNS its vote; the bridge's emergent `protocol.governance_round`
 * affordance — composing @interego/constitutional + content-addressing — recovers
 * each distinct signer (signer===agent_id, anti-Sybil), tallies, ratifies, forks on
 * dissensus, and mints a dereferenceable holon. The capability is DISCOVERED, not
 * a hardcoded path. Reasoning is the agents'; the tally/ratify/binding are deterministic.
 */
import { freshAgent, signEnvelope, type AgentWallet } from '../lib/agent-signing.js';
import { callTool } from '../lib/bridge.js';
import { oneShot } from '../lib/anthropic.js';

export interface GovAgent { wallet: AgentWallet; name: string; stance: string }
export interface GovEvent { id: number; actor: string; kind: 'identity' | 'phase' | 'propose' | 'vote' | 'tally' | 'ratify' | 'fork' | 'done' | 'error'; title: string; detail?: string; ts: string }
let counter = 0;
export function makeEmit(push: (e: GovEvent) => void) { return (e: Omit<GovEvent, 'id' | 'ts'>) => push({ ...e, id: counter++, ts: new Date().toISOString() }); }
export function resetCounter() { counter = 0; }
export interface RoundResult { status: string; tally: any; communityModal?: string; fork?: any; holon?: any; rules: any; castVotes?: Array<{ name: string; did: string; verdict: 'FOR' | 'AGAINST' | 'ABSTAIN'; atoms: string[] }> }

export function makePanel(stances: Array<{ name: string; stance: string }>): GovAgent[] {
  return stances.map(s => ({ wallet: freshAgent(), name: s.name, stance: s.stance }));
}

export async function runGovernanceRound(
  apiKey: string, emit: (e: Omit<GovEvent, 'id' | 'ts'>) => void,
  opts: { agents: GovAgent[]; proposerIdx?: number; policyId: string; tier: number; summary: string; addedRules?: string[]; rules: { minQuorum: number; threshold: number; coolingPeriodDays?: number }; forkOnReject?: boolean; context?: string; voteAtoms?: string[] },
): Promise<RoundResult> {
  const { agents } = opts;
  const proposer = agents[opts.proposerIdx ?? 0];
  const amendmentId = `urn:iep:amendment:${Date.now().toString(36)}`;
  emit({ actor: proposer.name, kind: 'propose', title: `proposes: ${opts.summary}`, detail: `tier ${opts.tier} · needs ≥${opts.rules.minQuorum} votes & ${(opts.rules.threshold * 100).toFixed(0)}% for` });

  const debate: string[] = [];
  const votes: any[] = [];
  const castVotes: RoundResult['castVotes'] = [];
  for (const a of agents) {
    const prompt = `You are ${a.name}, a self-governing agent. YOUR STANCE: ${a.stance}\n` +
      `${opts.context ? opts.context + '\n' : ''}A proposed amendment to the shared policy "${opts.policyId}" (tier ${opts.tier}): "${opts.summary}".\n` +
      (debate.length ? `Other agents have argued:\n${debate.join('\n')}\n` : '') +
      `Decide your vote strictly from your stance + the merits. Output exactly one line: "VOTE: FOR|AGAINST|ABSTAIN — <one-sentence reason>".`;
    let line = '';
    try { line = await oneShot(apiKey, prompt); } catch (e) { emit({ actor: a.name, kind: 'error', title: (e as Error).message }); }
    const m = /VOTE:\s*(FOR|AGAINST|ABSTAIN)\s*[—:-]*\s*([\s\S]*)/i.exec(line);
    const verdict = (m?.[1]?.toUpperCase() ?? 'ABSTAIN') as 'FOR' | 'AGAINST' | 'ABSTAIN';
    const reason = (m?.[2]?.trim() || line.trim() || '(no reason)').slice(0, 200);
    const modal = verdict === 'FOR' ? 'Asserted' : verdict === 'AGAINST' ? 'Counterfactual' : 'Hypothetical';
    debate.push(`- ${a.name}: ${verdict} — ${reason}`);
    emit({ actor: a.name, kind: 'vote', title: verdict, detail: reason });
    // The signed payload BINDS the voter to the exact vocabulary under vote (voteAtoms):
    // the ratification is then provably over THIS content-addressed term set — you cannot
    // later swap the vocabulary and claim the same signed quorum approved it.
    votes.push(await signEnvelope(a.wallet, { amendmentId, modalStatus: modal, ...(opts.voteAtoms ? { atoms: opts.voteAtoms } : {}) }));
    castVotes.push({ name: a.name, did: a.wallet.did, verdict, atoms: opts.voteAtoms ?? [] });
  }

  emit({ actor: 'consortium', kind: 'phase', title: 'Signed votes tallied + ratified on the substrate (protocol.governance_round)' });
  let j: any;
  try {
    j = await callTool('protocol.governance_round', {
      policyId: opts.policyId, tier: opts.tier,
      diff: { summary: opts.summary, ...(opts.addedRules ? { addedRules: opts.addedRules } : {}) },
      proposer: await signEnvelope(proposer.wallet, { amendmentId, proposes: opts.summary }),
      votes, rules: { ...opts.rules, coolingPeriodDays: opts.rules.coolingPeriodDays ?? 0 }, forkOnReject: !!opts.forkOnReject,
    });
  } catch (e) { emit({ actor: 'consortium', kind: 'error', title: (e as Error).message }); return { status: 'Error', tally: {}, rules: opts.rules }; }
  if (!j?.ok) { emit({ actor: 'consortium', kind: 'error', title: String(j?.error ?? 'governance_round failed') }); return { status: 'Error', tally: {}, rules: opts.rules }; }

  const ratified = j.amendment?.status === 'Ratified';
  emit({ actor: 'consortium', kind: 'tally', title: `tally: ${j.tally?.for} for · ${j.tally?.against} against · ${j.tally?.abstain} abstain (${j.tally?.distinctVoters} distinct signers)`, detail: `${(j.tally?.proportion * 100).toFixed(0)}% for vs ${(j.tally?.threshold * 100).toFixed(0)}% needed${j.droppedVotes ? ` · ${j.droppedVotes} forged/unbound votes dropped` : ''}` });
  emit({ actor: 'consortium', kind: 'ratify', title: ratified ? '✓ RATIFIED — the amendment is now policy' : `✗ ${j.amendment?.status} — not ratified`, detail: `community modal: ${j.communityModal} · holon ${String(j.holon?.holonUri ?? '').slice(0, 30)}…` });
  if (j.fork) emit({ actor: 'consortium', kind: 'fork', title: '⑂ dissenters forked the constitution', detail: `${(j.fork.dissenters ?? []).length} dissenter(s) → ${j.fork.newConstitution?.id}` });

  return { status: j.amendment?.status, tally: j.tally, communityModal: j.communityModal, fork: j.fork, holon: j.holon, rules: opts.rules, castVotes };
}
