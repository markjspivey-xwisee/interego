// Evaluator agent — reads every published design, runs each through
// the deterministic test battery, optionally uses Claude SDK to judge
// rules clarity + novelty, and publishes one signed attestation per
// design with a composite score.
//
// The substrate's promotion rule then picks the highest-attested
// design as the binding engine for the tournament.

import { Wallet } from 'ethers';
import { publishTournamentEvent } from '../substrate/client.mjs';
import { loadEngine, runTestBattery } from '../game/runtime.mjs';

/**
 * Run the evaluator. `designs` is the list of published design payloads.
 * Returns an array of attestation payloads.
 */
export async function runEvaluator({
  designs,
  tournamentId, tournamentPodUrl, tournamentOperator,
  log = console.log, smoke = false,
}) {
  const wallet = Wallet.createRandom();
  const did = `did:ethr:${wallet.address}`;
  log(`[evaluator] did=${did} reviewing ${designs.length} designs`);

  const attestations = [];
  for (const design of designs) {
    log(`[evaluator] running test battery on "${design.name}" by ${design.designerLabel}`);
    const loaded = loadEngine(design.engineSource);
    const battery = loaded.ok
      ? runTestBattery(loaded.exports)
      : { score: 0, passed: 0, total: 0, failures: [loaded.error] };

    // For the demo, novelty + rulesClarity come from the LLM (when not
    // smoke). Composite score weights deterministic battery heavily —
    // it's the substrate-honest verifier; novelty/clarity are taste.
    let novelty = 0.5, clarity = 0.5, judgeRationale = '';
    if (!smoke) {
      try {
        const judge = await claudeJudgeDesign({ design, log });
        novelty = judge.novelty;
        clarity = judge.clarity;
        judgeRationale = judge.rationale;
      } catch (err) {
        log(`[evaluator] LLM judge for "${design.name}" failed: ${err.message}`);
      }
    } else {
      // Smoke heuristic: novelty boost for the 'novelty' bias.
      novelty = design.bias === 'novelty' ? 0.8 : 0.4;
      clarity = 0.8;
      judgeRationale = '[smoke heuristic]';
    }

    const composite = (battery.score * 0.6) + (clarity * 0.2) + (novelty * 0.2);
    const attestation = {
      designId: design.designId,
      designName: design.name,
      evaluatorDid: did,
      battery,
      clarity, novelty,
      composite,
      judgeRationale,
      attestedAt: new Date().toISOString(),
    };
    await publishTournamentEvent({
      wallet: tournamentOperator.wallet, did: tournamentOperator.did,
      tournamentId, channel: 'attestations', payload: attestation,
    });
    attestations.push(attestation);
    log(`[evaluator] "${design.name}": battery=${battery.passed}/${battery.total} clarity=${clarity.toFixed(2)} novelty=${novelty.toFixed(2)} composite=${composite.toFixed(2)}`);
  }
  return attestations;
}

/**
 * Pick the binding design. The substrate-honest selection: highest
 * composite score wins. Ties broken by hash order so the rule is
 * deterministic across observers.
 *
 * If `attestations` covers only one design (the rest crashed), that
 * one wins by default — better than refusing to proceed.
 */
export function selectWinningDesign({ designs, attestations }) {
  const byId = new Map();
  for (const a of attestations) {
    const cur = byId.get(a.designId);
    if (!cur || a.composite > cur.composite) byId.set(a.designId, a);
  }
  const designsById = new Map(designs.map(d => [d.designId, d]));
  const ranked = [...byId.values()].sort((a, b) => {
    if (b.composite !== a.composite) return b.composite - a.composite;
    return a.designId.localeCompare(b.designId);
  });
  if (ranked.length === 0) {
    // No attestations — fall back to the first design that passes the
    // deterministic battery so the tournament can still start.
    for (const d of designs) {
      const loaded = loadEngine(d.engineSource);
      if (!loaded.ok) continue;
      const battery = runTestBattery(loaded.exports);
      if (battery.score >= 0.5) return { winner: d, attestation: null, fallback: true };
    }
    return { winner: null, attestation: null, fallback: true };
  }
  const winnerAtt = ranked[0];
  return {
    winner: designsById.get(winnerAtt.designId) ?? null,
    attestation: winnerAtt,
    fallback: false,
  };
}

// ── Claude SDK judge ─────────────────────────────────────────────

async function claudeJudgeDesign({ design, log }) {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const prompt =
`You are an LLM judge evaluating a game design. Score it on TWO axes, each 0..1:
  - clarity: how clearly do the rulesText and engineSource agree? Could you re-implement the engine just from the rulesText?
  - novelty: how interesting is the design relative to vanilla tic-tac-toe? 0 = literal vanilla, 1 = genuinely new mechanic.

DESIGN NAME
  ${design.name}

RULES TEXT
  ${design.rulesText}

ENGINE SOURCE
\`\`\`javascript
${(design.engineSource ?? '').slice(0, 4000)}
\`\`\`

Output ONE JSON object only:
  {"clarity": <0..1>, "novelty": <0..1>, "rationale": "<one short sentence>"}`;
  let combined = '';
  for await (const msg of query({
    prompt,
    options: {
      model: process.env.JUDGE_MODEL ?? 'claude-sonnet-4-6',
      maxTurns: 1,
      permissionMode: 'bypassPermissions',
      settingSources: [],
    },
  })) {
    if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
      for (const c of msg.message.content) if (c.type === 'text') combined += c.text;
    }
  }
  const m = combined.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('no JSON');
  const parsed = JSON.parse(m[0]);
  return {
    clarity: clamp01(parsed.clarity),
    novelty: clamp01(parsed.novelty),
    rationale: typeof parsed.rationale === 'string' ? parsed.rationale : '',
  };
}

function clamp01(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}
