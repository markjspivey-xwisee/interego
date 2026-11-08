/**
 * The shared chat-agent helpers (chat-agent.js beside this file) that Practice Evidence and Work
 * Redesign put in front of their own app.js. They are served by concatenation, not as a second
 * file: `/ui/app.js` is `chatAgentJs() + '\n' + <the site's app.js>`, so each page keeps its single
 * `<script type="module">` and the jsdom harnesses, which evaluate /ui/app.js as a classic script,
 * keep working. The file declares exactly one top-level name, `InteregoChatAgent`, a frozen object
 * with `actPrompt`, `requestAsText`, `extractJsonObject`, `agentAppName` and `nonceRule`. It has no
 * DOM, network or environment access, and nothing in it names a vertical.
 */
import { readFileSync } from 'node:fs';

let cached: string | null = null;

/** The chat-agent helpers' source, read once from beside this module. */
export function chatAgentJs(): string {
  cached ??= readFileSync(new URL('./chat-agent.js', import.meta.url), 'utf8');
  return cached;
}
