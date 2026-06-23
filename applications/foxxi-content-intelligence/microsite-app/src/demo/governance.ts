/**
 * Constitutional governance — shared runtime for The Quorum (#4) and /constitution
 * (#5). A panel of real LLM agents (each a self-sovereign wallet with its own
 * stance) DEBATE an amendment, then each SIGNS its vote. The bridge
 * (/agent/govern/amend) recovers each distinct signer (signer === claimed agent_id,
 * the same anti-Sybil binding as the calibration merge), tallies, applies the
 * ratification rule, and composes a dereferenceable holon — composing the existing
 * @interego/constitutional state machine. The reasoning is the agents'; the tally +
 * ratification + signature binding are deterministic.
 */
import { freshAgent, signEnvelope, type AgentWallet } from './agent-signing.js';
import { bridgeRest } from '../bridge-client.js';

export interface GovAgent { wallet: AgentWallet; name: string; stance: string }
export type Modal = 'Asserted' | 'Counterfactual' | 'Hypothetical'; // for / against / abstain

export interface GovEvent { id: number; actor: string; kind: 'identity' | 'phase' | 'propose' | 'debate' | 'vote' | 'tally' | 'ratify' | 'fork' | 'done' | 'error'; title: string; detail?: string; ts: string }
let counter = 0;
export function makeEmit(push: (e: GovEvent) => void) { return (e: Omit<GovEvent, 'id' | 'ts'>) => push({ ...e, id: counter++, ts: new Date().toISOString() }); }
export function resetCounter() { counter = 0; }

export interface RoundResult { status: string; tally: any; communityModal?: string; fork?: any; holon?: any; rules: any; amendment?: any }

const VERDICT = { Asserted: 'FOR', Counterfactual: 'AGAINST', Hypothetical: 'ABSTAIN' } as const;

export function makePanel(stances: Array<{ name: string; stance: string }>): GovAgent[] {
  return stances.map(s => ({ wallet: freshAgent(), name: s.name, stance: s.stance }));
}

/** One governance round: agents debate + sign votes; the bridge tallies + ratifies. */
export async function runGovernanceRound(
  apiKey: string, emit: (e: Omit<GovEvent, 'id' | 'ts'>) => void,
  opts: { agents: GovAgent[]; proposerIdx?: number; policyId: string; tier: number; summary: string; addedRules?: string[]; rules: { minQuorum: number; threshold: number; coolingPeriodDays?: number }; forkOnReject?: boolean; context?: string },
): Promise<RoundResult> {
  const { agents } = opts;
  const proposer = agents[opts.proposerIdx ?? 0];
  const amendmentId = `urn:foxxi:amendment:${Date.now().toString(36)}`;

  emit({ actor: proposer.name, kind: 'propose', title: `proposes: ${opts.summary}`, detail: `tier ${opts.tier} · needs ≥${opts.rules.minQuorum} votes & ${(opts.rules.threshold * 100).toFixed(0)}% for` });

  // Each agent reasons from its STANCE + the proposal + the debate so far, then votes.
  const debate: string[] = [];
  const votes: any[] = [];
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
    const modal: Modal = verdict === 'FOR' ? 'Asserted' : verdict === 'AGAINST' ? 'Counterfactual' : 'Hypothetical';
    debate.push(`- ${a.name}: ${verdict} — ${reason}`);
    emit({ actor: a.name, kind: 'vote', title: `${verdict}`, detail: reason });
    votes.push(await signEnvelope(a.wallet, { amendmentId, modalStatus: modal }));
  }

  const proposerEnv = await signEnvelope(proposer.wallet, { amendmentId, proposes: opts.summary });
  emit({ actor: 'consortium', kind: 'phase', title: 'Signed votes tallied + ratified on the bridge' });
  const { status: http, json } = await bridgeRest('/agent/govern/amend', {
    policyId: opts.policyId, tier: opts.tier,
    diff: { summary: opts.summary, ...(opts.addedRules ? { addedRules: opts.addedRules } : {}) },
    proposer: proposerEnv, votes, rules: { ...opts.rules, coolingPeriodDays: opts.rules.coolingPeriodDays ?? 0 },
    forkOnReject: !!opts.forkOnReject,
  });
  const j = json as any;
  if (http !== 200 || j?.ok === false) { emit({ actor: 'consortium', kind: 'error', title: String(j?.error ?? `HTTP ${http}`) }); return { status: 'Error', tally: {}, rules: opts.rules }; }

  const ratified = j.amendment?.status === 'Ratified';
  emit({ actor: 'consortium', kind: 'tally', title: `tally: ${j.tally?.for} for · ${j.tally?.against} against · ${j.tally?.abstain} abstain (${j.tally?.distinctVoters} distinct signers)`, detail: `${(j.tally?.proportion * 100).toFixed(0)}% for vs ${(j.tally?.threshold * 100).toFixed(0)}% needed${j.droppedVotes ? ` · ${j.droppedVotes} forged/unbound votes dropped` : ''}` });
  emit({ actor: 'consortium', kind: 'ratify', title: ratified ? `✓ RATIFIED — the amendment is now policy` : `✗ ${j.amendment?.status} — not ratified`, detail: `community modal: ${j.communityModal}` });
  if (j.fork) emit({ actor: 'consortium', kind: 'fork', title: `⑂ dissenters forked the constitution`, detail: `${(j.fork.dissenters ?? []).length} dissenter(s) → ${j.fork.newConstitution?.id}` });

  return { status: j.amendment?.status, tally: j.tally, communityModal: j.communityModal, fork: j.fork, holon: j.holon, rules: opts.rules, amendment: j.amendment };
}

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
export async function oneShot(apiKey: string, prompt: string): Promise<string> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(ANTHROPIC_URL, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' }, body: JSON.stringify({ model: 'claude-opus-4-8', max_tokens: 320, messages: [{ role: 'user', content: prompt }] }) });
    if (r.ok) { const j: any = await r.json(); return (j.content ?? []).filter((x: any) => x.type === 'text').map((x: any) => x.text).join('').trim(); }
    if ((r.status === 429 || r.status === 529 || r.status >= 500) && attempt < 3) { await new Promise(res => setTimeout(res, Math.min(8000, 600 * 2 ** attempt))); continue; }
    const t = await r.text().catch(() => ''); throw new Error(`Anthropic ${r.status}: ${t.slice(0, 160)}`);
  }
  throw new Error('Anthropic: exhausted retries');
}
