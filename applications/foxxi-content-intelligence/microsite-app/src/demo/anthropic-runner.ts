/**
 * In-browser Anthropic Messages tool-use loop (BYO key).
 *
 * Calls https://api.anthropic.com/v1/messages directly from the browser with the
 * user's own key + the `anthropic-dangerous-direct-browser-access` header (the
 * intended BYO-key browser pattern). The model decides which bridge tool to call;
 * this loop dispatches the real call and feeds the real result back, so the agent
 * trajectory is genuinely emergent over the live affordances.
 */
import type { ToolDef } from './agent-tools.js';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
export const DEMO_MODEL = 'claude-opus-4-8';

interface AnthropicBlock { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }
interface AnthropicMsg { role: 'user' | 'assistant'; content: string | AnthropicBlock[] }

export interface AgentLoopOpts {
  apiKey: string;
  system: string;
  goal: string;
  tools: ToolDef[];
  dispatch: (name: string, input: Record<string, unknown>) => Promise<{ text: string }>;
  onThinking: (text: string) => void;
  onToolCall: (name: string, input: Record<string, unknown>) => void;
  onToolResult: (name: string, resultText: string) => void;
  maxSteps?: number;
  model?: string;
}

/** Run one agent's bounded tool-use loop until it stops calling tools (or hits maxSteps). */
export async function runAgentLoop(opts: AgentLoopOpts): Promise<void> {
  const messages: AnthropicMsg[] = [{ role: 'user', content: opts.goal }];
  const maxSteps = opts.maxSteps ?? 10;

  for (let step = 0; step < maxSteps; step++) {
    // Transient-error resilience: the Anthropic API can return 429 (rate limit)
    // or 529 (overloaded) under load. Retry those (and 5xx) with exponential
    // backoff before giving up, so a momentary blip doesn't abort the whole run.
    let resp: Response | null = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      resp = await fetch(ANTHROPIC_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': opts.apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model: opts.model ?? DEMO_MODEL,
          max_tokens: 1800,
          system: opts.system,
          tools: opts.tools,
          messages,
        }),
      });
      if (resp.ok) break;
      const transient = resp.status === 429 || resp.status === 529 || resp.status >= 500;
      if (!transient || attempt === 4) {
        const t = await resp.text().catch(() => '');
        throw new Error(`Anthropic ${resp.status}: ${t.slice(0, 240)}`);
      }
      await new Promise(r => setTimeout(r, Math.min(8000, 600 * 2 ** attempt)));
    }
    const data = await resp!.json() as { content?: AnthropicBlock[]; stop_reason?: string };
    const content = data.content ?? [];
    messages.push({ role: 'assistant', content });

    const text = content.filter(b => b.type === 'text').map(b => b.text ?? '').join('\n').trim();
    if (text) opts.onThinking(text);

    const toolUses = content.filter(b => b.type === 'tool_use');
    if (toolUses.length === 0 || data.stop_reason !== 'tool_use') return; // agent finished

    const toolResults: AnthropicBlock[] = [];
    for (const tu of toolUses) {
      const name = tu.name ?? '';
      const input = (tu.input ?? {}) as Record<string, unknown>;
      opts.onToolCall(name, input);
      let resultText: string;
      try { resultText = (await opts.dispatch(name, input)).text; }
      catch (e) { resultText = JSON.stringify({ error: (e as Error).message }); }
      // Truncate huge bodies so the context stays lean.
      if (resultText.length > 6000) resultText = resultText.slice(0, 6000) + ' …[truncated]';
      opts.onToolResult(name, resultText);
      toolResults.push({ type: 'tool_result', id: tu.id, text: resultText } as AnthropicBlock);
    }
    // tool_result blocks reference the tool_use id via tool_use_id.
    messages.push({ role: 'user', content: toolResults.map(r => ({ type: 'tool_result', tool_use_id: r.id, content: r.text })) as unknown as AnthropicBlock[] });
  }
}
