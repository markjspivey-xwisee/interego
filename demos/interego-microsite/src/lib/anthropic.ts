/**
 * In-browser BYOK Anthropic calls — a one-shot completion and a bounded tool-use
 * loop. Key goes ONLY to api.anthropic.com (anthropic-dangerous-direct-browser-
 * access), never to our servers. Retries transient 429/529/5xx with backoff.
 */
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
export const MODEL = 'claude-opus-4-8';

interface Block { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }
interface Msg { role: 'user' | 'assistant'; content: string | Block[] }
export interface ToolDef { name: string; description: string; input_schema: { type: 'object'; properties: Record<string, unknown>; required?: string[] } }

async function post(apiKey: string, body: Record<string, unknown>): Promise<any> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
      body: JSON.stringify(body),
    });
    if (r.ok) return r.json();
    const transient = r.status === 429 || r.status === 529 || r.status >= 500;
    if (!transient || attempt === 4) { const t = await r.text().catch(() => ''); throw new Error(`Anthropic ${r.status}: ${t.slice(0, 200)}`); }
    await new Promise(res => setTimeout(res, Math.min(8000, 600 * 2 ** attempt)));
  }
  throw new Error('Anthropic: exhausted retries');
}

/** One-shot completion (no tools). */
export async function oneShot(apiKey: string, prompt: string, maxTokens = 320): Promise<string> {
  const j = await post(apiKey, { model: MODEL, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] });
  return (j.content ?? []).filter((b: Block) => b.type === 'text').map((b: Block) => b.text ?? '').join('').trim();
}

export interface AgentLoopOpts {
  apiKey: string; system: string; goal: string; tools: ToolDef[];
  dispatch: (name: string, input: Record<string, unknown>) => Promise<{ text: string }>;
  onThinking: (text: string) => void; maxSteps?: number;
}

/** Bounded tool-use loop — the model decides which tool to call; we dispatch the
 *  real call and feed the result back. The trajectory is emergent over the tools. */
export async function runAgentLoop(opts: AgentLoopOpts): Promise<void> {
  const messages: Msg[] = [{ role: 'user', content: opts.goal }];
  const maxSteps = opts.maxSteps ?? 10;
  for (let step = 0; step < maxSteps; step++) {
    const data = await post(opts.apiKey, { model: MODEL, max_tokens: 1800, system: opts.system, tools: opts.tools, messages });
    const content: Block[] = data.content ?? [];
    messages.push({ role: 'assistant', content });
    const text = content.filter(b => b.type === 'text').map(b => b.text ?? '').join('\n').trim();
    if (text) opts.onThinking(text);
    const toolUses = content.filter(b => b.type === 'tool_use');
    if (toolUses.length === 0 || data.stop_reason !== 'tool_use') return;
    const results: Block[] = [];
    for (const tu of toolUses) {
      let resultText: string;
      try { resultText = (await opts.dispatch(tu.name ?? '', (tu.input ?? {}) as Record<string, unknown>)).text; }
      catch (e) { resultText = JSON.stringify({ error: (e as Error).message }); }
      if (resultText.length > 6000) resultText = resultText.slice(0, 6000) + ' …[truncated]';
      results.push({ type: 'tool_result', id: tu.id, text: resultText } as Block);
    }
    messages.push({ role: 'user', content: results.map(r => ({ type: 'tool_result', tool_use_id: r.id, content: r.text })) as unknown as Block[] });
  }
}
