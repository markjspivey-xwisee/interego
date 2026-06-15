// Verifiers — deterministic + LLM judge.
//
// OpenAI's "stacked verifiers" thesis: cheap deterministic checks run
// on every tick (tests, type-check, lint); expensive inferential ones
// (LLM judge) run later as a tie-breaker. This module ships both as
// pure functions the controller calls between Claude turns.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Deterministic verifier — run the task's tests.
 *
 * Returns { pass, durationMs, stdout, stderr }. A pass means every
 * test in the task fixture exited green. Used as the OpenAI-style
 * "green-light gate" before promoting a tick's Hypothetical implementation
 * step to Asserted.
 */
export async function runDeterministicTests({ task, workspaceRoot }) {
  // implementation_file in task is ALWAYS workspace-root-relative
  // (e.g. "workspace/modalDistribution.mjs" or "workspace-alpha/..."),
  // so resolve straight from workspaceRoot — do NOT prefix with
  // task.workspace, which would double-resolve in collective mode.
  const implAbsPath = resolvePath(workspaceRoot, task.implementation_file);
  if (!existsSync(implAbsPath)) {
    return {
      pass: false,
      durationMs: 0,
      stdout: '',
      stderr: `implementation file not yet present at ${task.implementation_file} — agent has not authored anything yet.`,
    };
  }
  const t0 = Date.now();
  // Use node --test directly, scoped to the test file declared in the task.
  const testFile = resolvePath(workspaceRoot, task.tests.file);
  const proc = spawn(process.execPath, ['--test', testFile], {
    cwd: workspaceRoot,
    env: { ...process.env, NODE_OPTIONS: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  proc.stdout.on('data', c => { stdout += c.toString(); });
  proc.stderr.on('data', c => { stderr += c.toString(); });
  const exit = await new Promise(resolve => proc.on('exit', resolve));
  return {
    pass: exit === 0,
    durationMs: Date.now() - t0,
    stdout: stdout.slice(0, 2_000),
    stderr: stderr.slice(0, 2_000),
  };
}

/**
 * LLM judge — uses the Claude Code SDK to score the candidate
 * implementation on correctness AND reuse-vs-rewrite (the demo's
 * teaching signal). Returns { reuseScore, correctnessScore, rationale }.
 *
 * The judge runs WITHOUT mcp servers — it only sees the candidate
 * source + the tests + the task description. That isolation keeps
 * the score honest (no tool-call score-stuffing).
 */
export async function llmJudge({ task, implementationSource, peerImplementationSource, peerLabel }) {
  // Import the SDK lazily so the demo doesn't fail to load if the
  // package isn't installed (smoke-test mode is allowed to skip judge).
  let query, settingSourcesAvailable;
  try {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    query = sdk.query;
    settingSourcesAvailable = true;
  } catch (err) {
    return {
      reuseScore: 0,
      correctnessScore: 0,
      rationale: '@anthropic-ai/claude-agent-sdk not installed — judge skipped (run `npm i --no-save @anthropic-ai/claude-agent-sdk zod` in the repo root).',
      skipped: true,
    };
  }
  const prompt =
`You are an LLM JUDGE comparing two candidate implementations of a small JavaScript task.
Score each on TWO axes, 0..1 each:
  - correctness: does the code look like it will pass the tests below?
  - reuse: did the author look for and reuse existing patterns,
    or did they write everything from scratch?

OUTPUT FORMAT (one JSON object only, no preamble, no markdown fences):
  {"primary":{"correctness":<0..1>,"reuse":<0..1>},"peer":{"correctness":<0..1>,"reuse":<0..1>},"rationale":"<one sentence>"}

TASK DESCRIPTION
  ${task.description}

TESTS
  ${task.tests.summary}

CANDIDATE: primary
\`\`\`javascript
${implementationSource ?? '(not yet authored)'}
\`\`\`

CANDIDATE: ${peerLabel ?? 'peer'}
\`\`\`javascript
${peerImplementationSource ?? '(not yet authored)'}
\`\`\`

Respond with ONLY the JSON object.`;
  let combined = '';
  try {
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
        for (const c of msg.message.content) {
          if (c.type === 'text') combined += c.text;
        }
      }
    }
  } catch (err) {
    return {
      reuseScore: 0,
      correctnessScore: 0,
      rationale: `judge failed: ${err.message}`,
      skipped: true,
    };
  }
  try {
    // The model is asked to return JSON only; tolerate small wrappers.
    const jsonMatch = combined.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : combined);
    return {
      correctnessScore: clamp01(parsed.primary?.correctness),
      reuseScore: clamp01(parsed.primary?.reuse),
      peerCorrectnessScore: clamp01(parsed.peer?.correctness),
      peerReuseScore: clamp01(parsed.peer?.reuse),
      rationale: typeof parsed.rationale === 'string' ? parsed.rationale : '',
    };
  } catch (err) {
    return {
      reuseScore: 0.5, correctnessScore: 0.5,
      rationale: `judge returned non-JSON; parsed as draw. Raw: ${combined.slice(0, 200)}`,
      skipped: true,
    };
  }
}

function clamp01(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
