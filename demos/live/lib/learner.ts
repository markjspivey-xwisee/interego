/**
 * The agent as a learner: a Claude agent with no tools reads each section the SCORM engine
 * delivers and answers its questions. It sees exactly what a human learner sees (the section's
 * title, text and questions) and never the answer key, which only exists as hashes on the bridge.
 */
import { runClaudeAgent, type AgentEvent } from './claude-agent.js';

export interface DeliveredSection {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly assessment?: readonly { readonly question: string; readonly index: number }[];
}

const PROMPT = (s: DeliveredSection, questions: readonly { question: string; index: number }[]): string => `You are an AI agent taking a short course. Read this section, then answer its questions.

Section ${s.id}: ${s.title}
${s.body}

Questions:
${questions.map((q, i) => `${i + 1}. ${q.question}`).join('\n')}

Answer each question with ONE lowercase word taken from the section. Reply with ONLY a JSON object, no prose and no code fence: {"answers":["<word for question 1>", ...]}`;

/** Read one section and answer its questions, in the engine's question order; the reading streams through `onEvent`. */
export async function answerSection(section: DeliveredSection, onEvent: (e: AgentEvent) => void): Promise<{ answers: string[]; costUsd?: number }> {
  const questions = [...(section.assessment ?? [])].sort((a, b) => a.index - b.index);
  if (questions.length === 0) return { answers: [] };
  const run = await runClaudeAgent({ prompt: PROMPT(section, questions), mcpServers: {}, tools: '', maxTurns: 2, timeoutMs: 180_000, onEvent });
  if (!run.result) throw new Error(run.events.find((e) => e.kind === 'error')?.text ?? 'the learner agent returned nothing');
  const m = /\{[\s\S]*\}/.exec(run.result.replace(/```(?:json)?/g, ''));
  if (!m) throw new Error('the learner agent did not return a JSON object');
  const parsed = JSON.parse(m[0]) as { answers?: unknown };
  const answers = (Array.isArray(parsed.answers) ? parsed.answers : []).map((a) => String(a).trim().toLowerCase());
  while (answers.length < questions.length) answers.push('');
  return { answers: answers.slice(0, questions.length), ...(run.costUsd !== undefined ? { costUsd: run.costUsd } : {}) };
}
