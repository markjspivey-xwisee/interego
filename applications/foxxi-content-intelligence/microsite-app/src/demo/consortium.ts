/**
 * Federated Calibration — the BYOK LLM analyst.
 *
 * The merge itself is DETERMINISTIC: each org signs its aggregate cells, the bridge
 * recovers the contributors, applies the k-sample suppression floor, pools across
 * distinct keys, and promotes a cell to Asserted only above the assert threshold.
 * That math is the thing you trust and must stay deterministic.
 *
 * This adds a genuine Claude analyst agent (its own self-sovereign wallet) that
 * reasons over the pooled, cryptographically-merged memory: it interrogates the
 * merged holon (real tool call), respects the substrate-computed modal status +
 * sample counts (it cannot fake them), and writes an actionable recommendation —
 * what to ADOPT now vs. keep gathering. The math is deterministic; the judgment is
 * the agent's. Requires an Anthropic key.
 */
import { freshAgent } from './agent-signing.js';
import { dispatchTool, toolList, type ToolName } from './agent-tools.js';
import { runAgentLoop } from './anthropic-runner.js';

const STD_EXT_IRI =
  'https://markjspivey-xwisee.github.io/interego/applications/agentic-performance-practice/agp#StandardsExtension';

export interface ConsortiumEvent { kind: 'identity' | 'tool' | 'reasoning' | 'recommendation' | 'error'; text: string; detail?: string }
export interface ConsortiumAnalysis { recommendation: string; interrogated: boolean }

const ANALYST_SYS =
  'You are a consortium analyst agent on the Interego/Foxxi substrate with your own self-sovereign did:ethr identity. You reason ONLY over the pooled, cryptographically-merged calibration evidence — the modal status (Asserted / Hypothetical) and the sample counts are computed by the substrate and you MUST respect them (never upgrade a Hypothetical cell on your own). Be concrete and decision-oriented. Finish with exactly one line: "RECOMMENDATION: <2-3 sentences naming what to ADOPT now vs. keep gathering>".';

export async function analyzeMergedCalibrationLLM(
  apiKey: string, emit: (e: ConsortiumEvent) => void, merge: any,
): Promise<ConsortiumAnalysis> {
  const A = freshAgent();
  emit({ kind: 'identity', text: 'Fresh consortium ANALYST agent (a real LLM) — reasons over the pooled memory', detail: A.did });

  const holonUri: string | undefined = merge?.holon?.holonUri;
  // The lattice label is the pod segment immediately BEFORE "foxxi-lattice" in the
  // descriptor URL (e.g. .../course-calibration-consortium/foxxi-lattice/holon-x.ttl
  // → "course-calibration-consortium"). (slice(-2,-1) would wrongly pick
  // "foxxi-lattice" itself and 404.)
  const segs = String(merge?.holon?.descriptorUrl || '').split('/').filter(Boolean);
  const li = segs.indexOf('foxxi-lattice');
  const label = (li > 0 ? segs[li - 1] : segs.slice(-3, -2)[0]) || 'calibration-consortium';
  const cells = (merge?.merged?.cells ?? []).map((c: any) =>
    `${c.intervention} for ${c.causeFactor}/${c.regime}: ${c.samples} pooled samples, closes ${Math.round((c.closureRate ?? 0) * 100)}%, ${c.modalStatus}`,
  ).join('\n');
  let interrogated = false;

  const dispatch = async (name: string, input: Record<string, unknown>): Promise<{ text: string }> => {
    emit({ kind: 'tool', text: name, detail: name === 'interrogate_holon' ? 'the merged calibration holon' : String(input.task_name ?? '') });
    const r = await dispatchTool(name, input, A, { holonUri, label, subjectDid: A.did });
    if (name === 'interrogate_holon' && r.ok) interrogated = true;
    emit({ kind: 'tool', text: `signed → ${name} · HTTP ${r.status}${r.ok ? ' ✓' : ' ✗'}` });
    return { text: typeof r.body === 'string' ? r.body : JSON.stringify(r.body) };
  };

  const goal =
    `Two rival orgs pooled their PRIVATE outcome evidence into ONE calibration memory. No raw record crossed a boundary — the substrate applied a k-sample suppression floor and promoted a cell to Asserted only above the assert threshold. The merged cells:\n${cells || '(no cells cleared the suppression floor)'}\n` +
    (holonUri
      ? `The merged memory is a dereferenceable holon ${holonUri} in lattice ${label}. Interrogate it (interrogate_holon, no args needed) to understand its structure, then write your recommendation.\n`
      : `(No holon was projected on this deployment — reason from the merged cells above.)\n`) +
    `Write an ACTIONABLE recommendation for a member org: which intervention(s) to ADOPT now (Asserted + high closure), which are still uncertain (Hypothetical — keep gathering), and the single most useful next step. Record it: call record_performance (task_name "Consortium recommendation", success true, quality 1, activity_type "${STD_EXT_IRI}").\n` +
    `Finish: RECOMMENDATION: <2-3 sentences>.`;

  let finalText = '';
  try {
    await runAgentLoop({
      apiKey, system: ANALYST_SYS, goal,
      tools: toolList((holonUri ? ['interrogate_holon', 'record_performance'] : ['record_performance']) as ToolName[]),
      dispatch,
      onThinking: t => { finalText = t; emit({ kind: 'reasoning', text: t }); },
      onToolCall: () => {}, onToolResult: () => {}, maxSteps: 6,
    });
  } catch (e) { emit({ kind: 'error', text: (e as Error).message }); }

  const m = /RECOMMENDATION:\s*([\s\S]+)/i.exec(finalText);
  const recommendation = (m?.[1]?.trim() || finalText.trim() || 'the analyst agent did not return a parseable recommendation').slice(0, 600);
  emit({ kind: 'recommendation', text: recommendation });
  return { recommendation, interrogated };
}
