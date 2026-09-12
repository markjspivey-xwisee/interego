import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, access, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUDGET, bind, decisionSchema, promptFor, validateDecision, type Controller, type Observation } from './controller.js';
import { createEnvironment } from './environment.js';

const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
const exists = async (path: string) => access(path).then(() => true, () => false);
async function json(path: string, value: unknown) { await writeFile(path + '.tmp', JSON.stringify(value, null, 2) + '\n'); await rename(path + '.tmp', path); }
export interface Case { controller: Controller; arm: 'baseline' | 'interego'; scenario: 'stable' | 'rebind' | 'stale' | 'handoff'; seed: number }

export async function runCase(spec: Case, dir: string) {
  await mkdir(dir, { recursive: true });
  if ((await readdir(dir)).length) throw new Error('case directory must be empty; old responses cannot be reused');
  const env = await createEnvironment(spec);
  const started = Date.now();
  const modelDecisions: unknown[] = []; const events: unknown[] = [];
  const outputs = new Map<string, unknown>(); const memory = new Map<string, unknown>();
  let observations: Observation[] = []; let calls = 0; let generation = 0; let handedOff = false; let finished = false;
  let lastVerifiedReadAtMoves = -1; let finalError: string | undefined;
  let decisionWaitMs = 0; let toolMs = 0; let maxParallelTools = 0;
  await json(join(dir, 'case.json'), spec);
  try {
    for (let request = 0; request < BUDGET.decisions && calls < BUDGET.tools && !finished; request++) {
      const remaining = { decisions: BUDGET.decisions - request, tools: BUDGET.tools - calls };
      const prompt = promptFor(spec.controller, env.handle, observations, remaining);
      const stem = `decision-${String(request).padStart(2, '0')}`;
      const requestPath = join(dir, stem + '.request.json'); const responsePath = join(dir, stem + '.response.json');
      await json(requestPath, { protocol: 'controller-surface/v1', generation, prompt, schema: decisionSchema, responsePath });
      await json(join(dir, 'pending.json'), { requestPath, responsePath, generation });
      const waiting = Date.now();
      while (!await exists(responsePath)) {
        if (Date.now() - waiting > 10 * 60_000) throw new Error('model decision transport timed out');
        await pause(100);
      }
      decisionWaitMs += Date.now() - waiting;
      const submission = await readFile(responsePath, 'utf8');
      const trace: Record<string, unknown> = { request, generation, promptSha256: createHash('sha256').update(prompt).digest('hex'), submission, transportWaitMs: Date.now() - waiting };
      modelDecisions.push(trace);
      let decision;
      try { const raw = JSON.parse(submission); trace.output = raw; decision = validateDecision(raw, spec.controller, new Set(outputs.keys())); }
      catch (error) { trace.error = String(error); observations.push({ id: `protocol-${request}`, tool: 'protocol', result: { error: String(error) } }); continue; }
      const pending = [...decision.nodes]; let interrupted = false;
      while (pending.length && calls < BUDGET.tools && !interrupted) {
        const ready = pending.filter(n => n.dependsOn.every(id => outputs.has(id)));
        if (!ready.length) throw new Error('no executable node');
        // Mutations never share a wave. Independent reads are actually concurrent.
        const firstWrite = ready.find(n => n.tool === 'invoke' || n.tool === 'remember');
        const wave = firstWrite ? [firstWrite] : ready.slice(0, BUDGET.tools - calls);
        maxParallelTools = Math.max(maxParallelTools, wave.length);
        for (const n of wave) pending.splice(pending.indexOf(n), 1);
        const waveStart = Date.now();
        const results = await Promise.all(wave.map(async node => {
          calls++;
          let args: Record<string, unknown>; let result: unknown;
          try {
            args = bind(JSON.parse(node.args), outputs) as Record<string, unknown>;
            if (node.tool === 'remember') {
              if (typeof args.key !== 'string' || args.value === undefined || Buffer.byteLength(JSON.stringify(args.value)) > 16000) throw new Error('invalid memory value');
              memory.set(args.key, structuredClone(args.value)); result = { stored: true };
            } else if (node.tool === 'recall') result = { value: memory.get(String(args.key)) ?? null };
            else result = await env.call(node.tool, args);
          } catch (error) { args = {}; result = { status: 400, error: String(error), committed: false }; }
          const record = { id: node.id, tool: node.tool, result };
          events.push({ ...record, args, generation, request, atMs: Date.now() - started });
          outputs.set(node.id, result); observations.push(record);
          const status = result as Record<string, unknown>;
          if (node.tool === 'read' && status.verified === true) lastVerifiedReadAtMoves = Number((status.taskProgress as { completedMoves?: number })?.completedMoves);
          return { node, result: status };
        }));
        toolMs += Date.now() - waveStart;
        if (results.some(({ result }) => typeof result.status === 'number' && result.status >= 400 || result.error)) interrupted = true;
        if (spec.scenario === 'handoff' && !handedOff && Number(env.inspect().taskMoves) >= 1) {
          handedOff = true; generation++; observations = []; outputs.clear(); interrupted = true;
          events.push({ type: 'handoff', atMs: Date.now() - started, retained: ['task', 'handle', 'durable environment', 'durable memory'], discarded: ['conversation', 'outputs', 'pending plan'] });
        }
      }
      if (decision.finish && !interrupted && pending.length === 0) finished = true;
    }
  } catch (error) { finalError = String(error); }
  const inspection = env.inspect();
  const success = finished && inspection.completed === true && lastVerifiedReadAtMoves === 3 && !finalError;
  const result = { ...spec, success, finished, finalError: finalError ?? null, modelDecisionRequests: modelDecisions.length,
    providerInferenceCalls: null, inputTokens: null, outputTokens: null, cachedTokens: null, dollarCost: null,
    toolCalls: calls, toolMs, decisionTransportWaitMs: decisionWaitMs, elapsedMs: Date.now() - started, maxParallelTools,
    handedOff, generations: generation + 1, lastVerifiedReadAtMoves, inspection, modelDecisions, events };
  await json(join(dir, 'result.json'), result);
  await json(join(dir, 'pending.json'), { done: true, success, generation });
  return result;
}

async function main() {
  const out = resolve(process.argv[2] ?? 'benchmarks/controller-surface/results/pilot-20260912');
  const seeds = (process.argv[3] ?? '0,1').split(',').map(Number);
  const cases: Case[] = [];
  for (const seed of seeds) for (const scenario of ['stable', 'rebind', 'stale', 'handoff'] as const) {
    const arms: Case[] = [];
    for (const controller of ['react', 'dag'] as const) for (const arm of ['baseline', 'interego'] as const) arms.push({ seed, scenario, controller, arm });
    // Counterbalanced fixed rotation, declared before observations; no outcome-driven reruns.
    const rotation = (seed + ['stable', 'rebind', 'stale', 'handoff'].indexOf(scenario)) % 4;
    cases.push(...arms.slice(rotation), ...arms.slice(0, rotation));
  }
  await mkdir(out, { recursive: true });
  await json(join(out, 'manifest.json'), { protocol: 'controller-surface/v1', createdAt: new Date().toISOString(), budget: BUDGET, cases,
    provider: 'collaboration agents; inherited same model/settings; exact provider snapshot and token usage unavailable',
    modelBudget: 'decision requests and serialized output bytes bounded; provider tokens and hidden inference requests not observable',
    transport: 'local Ed25519 verified store; actual Interego composition versus conventional JSON adapter; no production writes' });
  let next = 0;
  const results: unknown[] = [];
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (next < cases.length) {
      const spec = cases[next++]!;
      const id = `${spec.scenario}-${spec.seed}-${spec.controller}-${spec.arm}`;
      console.log('START ' + id);
      const result = await runCase(spec, join(out, id)); results.push(result);
      console.log('DONE ' + id + ' ' + result.success);
    }
  }));
  await json(join(out, 'results.json'), results);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
