/**
 * The course the agent teaches you, written live by a Claude agent with no tools: a short SCORM
 * course on a topic you name, as the JSON the bridge's authoring route takes. Each question's
 * answer is one word that appears in its section, because the engine grades free text against a
 * hash of the author's answer and you should be able to find it by reading.
 */
import { runClaudeAgent, type AgentEvent } from './claude-agent.js';

export interface AuthoredCourse {
  courseId: string;
  title: string;
  masteryScore: number;
  summary: string;
  scos: { id: string; title: string; body: string; assessment?: { question: string; answer: string }[] }[];
}

const PROMPT = (topic: string, courseId: string): string => `Write a very short course that teaches this topic: ${topic}

Reply with ONLY a JSON object, no prose and no code fence, in exactly this shape:
{"courseId":"${courseId}","title":"<5 to 8 words>","masteryScore":0.5,"summary":"<one sentence on what the learner will understand>","scos":[
 {"id":"SCO-1","title":"<title>","body":"<60 to 110 words that teach the first idea>"},
 {"id":"SCO-2","title":"<title>","body":"<60 to 110 words that teach the second idea>","assessment":[{"question":"<question>","answer":"<ONE word>"}]},
 {"id":"SCO-3","title":"<title>","body":"<60 to 110 words that teach the third idea>","assessment":[{"question":"<question>","answer":"<ONE word>"}]}
]}

Rules: every answer is a single lowercase word with no punctuation that appears verbatim in the body of its own section, and a careful reader of that section can find it without guessing. Plain language, accurate, no filler.`;

/** Parse the JSON the author wrote, tolerating a code fence; throw with the reason when it is not a course. */
export function parseCourse(text: string, courseId: string): AuthoredCourse {
  const m = /\{[\s\S]*\}/.exec(text.replace(/```(?:json)?/g, ''));
  if (!m) throw new Error('the author did not return a JSON object');
  const c = JSON.parse(m[0]) as AuthoredCourse;
  if (!Array.isArray(c.scos) || c.scos.length === 0) throw new Error('the course has no sections');
  c.courseId = courseId;
  c.masteryScore = typeof c.masteryScore === 'number' ? c.masteryScore : 0.5;
  for (const s of c.scos) {
    for (const q of s.assessment ?? []) {
      q.answer = String(q.answer).trim().toLowerCase().replace(/[^\p{L}\p{N}-]+/gu, '');
      if (!q.answer) throw new Error(`section ${s.id} has a question with no answer`);
    }
  }
  return c;
}

/** A course a person wrote in the page, checked and normalized as the author's JSON is; throws with what to fix. */
export function courseFromForm(input: unknown, courseId: string): AuthoredCourse {
  const c = (input && typeof input === 'object' ? input : {}) as { title?: unknown; summary?: unknown; scos?: unknown };
  const title = String(c.title ?? '').trim();
  if (!title) throw new Error('give your course a title');
  const rawScos = Array.isArray(c.scos) ? (c.scos as Array<{ title?: unknown; body?: unknown; assessment?: unknown }>) : [];
  const scos = rawScos.map((s, i) => {
    const questions = (Array.isArray(s?.assessment) ? (s.assessment as Array<{ question?: unknown; answer?: unknown }>) : [])
      .filter((q) => String(q?.question ?? '').trim())
      .map((q) => {
        const said = String(q.answer ?? '').trim().toLowerCase();
        // One word, as the engine grades it: joining "machine learning" into "machinelearning" would publish an answer no reader can give.
        if (said.split(/\s+/).filter(Boolean).length > 1) throw new Error(`the answer to “${String(q.question).trim()}” must be one word, not “${said}”`);
        return { question: String(q.question).trim(), answer: said.replace(/[^\p{L}\p{N}-]+/gu, '') };
      });
    return { id: `SCO-${i + 1}`, title: String(s?.title ?? '').trim() || `Section ${i + 1}`, body: String(s?.body ?? '').trim(), ...(questions.length ? { assessment: questions } : {}) };
  });
  if (scos.length === 0) throw new Error('your course needs at least one section');
  for (const s of scos) {
    if (!s.body) throw new Error(`“${s.title}” has no text`);
    for (const q of s.assessment ?? []) if (!q.answer) throw new Error(`the question “${q.question}” has no one-word answer`);
  }
  if (!scos.some((s) => s.assessment?.length)) throw new Error('ask at least one question, or the engine has nothing to grade');
  return { courseId, title, masteryScore: 0.5, summary: String(c.summary ?? '').trim(), scos };
}

/** Have a Claude agent write the course; its steps stream through `onEvent`. */
export async function authorCourse(topic: string, courseId: string, onEvent: (e: AgentEvent) => void): Promise<{ course: AuthoredCourse; costUsd?: number }> {
  const run = await runClaudeAgent({ prompt: PROMPT(topic, courseId), mcpServers: {}, tools: '', maxTurns: 2, timeoutMs: 180_000, onEvent });
  if (!run.result) throw new Error(run.events.find((e) => e.kind === 'error')?.text ?? 'the author agent returned nothing');
  return { course: parseCourse(run.result, courseId), ...(run.costUsd !== undefined ? { costUsd: run.costUsd } : {}) };
}
