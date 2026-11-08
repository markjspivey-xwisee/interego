/**
 * The ONE shape of a relay tool result, for every MCP transport the relay serves.
 *
 * ── WHAT A RESULT CARRIES, AND FOR WHOM ──────────────────────────────────────
 *
 *   structuredContent  the machine result. It conforms to the tool's declared
 *                      outputSchema; ChatGPT and strict MCP clients read it, and the
 *                      HyperMarkdown widget hydrates from it.
 *   content[0]         the SAME result as JSON text. This is the MCP back-compat copy,
 *                      and it stays FIRST: several readers in this repository and outside
 *                      it take the first text block and JSON.parse it.
 *   content[1]         one short line saying what came back. It never repeats a body.
 *   _meta              only what a widget needs and the model must not see. Nothing here
 *                      puts a copy of the result in it.
 *
 * ── ★ HOW MANY COPIES A MODEL READS DEPENDS ON THE CLIENT ────────────────────
 *
 * The layout above gives a client that shows its model only `content` exactly one copy. It
 * gives ChatGPT TWO: OpenAI's Apps SDK documents both `structuredContent` and `content` as
 * "surfaced to the model", and `_meta` as the only field hidden from it. ChatGPT is the client
 * whose report started this, so for a session the relay identifies as ChatGPT (the OAuth
 * client's registered name, mapped to the same surface slug identity mints agents under)
 * {@link relayToolResult} leaves the JSON copy out of `content` and sends the summary line
 * alone. structuredContent is unchanged, so ChatGPT's model and its widget (`toolOutput`)
 * still read the whole result, once. Every other client keeps the JSON first.
 *
 * ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────
 *
 * The /mcp dispatcher and the legacy /messages dispatcher each built this envelope by hand,
 * and a client reported results that looked several times their real size. Measured on the
 * relay booted against loopback fixtures, every tool result carried the full payload exactly
 * twice — content[0].text and structuredContent, byte-identical — and nothing else; there was
 * no third copy in markdown or _meta on act, discover_context, get_descriptor or read_inbox.
 * The size came from WHAT was copied (an unbounded inbox, a target's response body as an
 * escaped string, the inline JSON-LD context), not from a third copy. One builder keeps the
 * two transports from drifting apart while those payloads are bounded where they are made.
 */
import { toStructuredContent } from '@interego/core';

/** The longest summary line, in characters. A summary is a pointer, never a payload. */
export const SUMMARY_MAX_CHARS = 240;

type Text = { type: 'text'; text: string };
export interface RelayToolResult {
  [key: string]: unknown;
  content: Text[];
  structuredContent: Record<string, unknown>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

function clip(text: string, max = SUMMARY_MAX_CHARS): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * How a session's client presents a result to its model. Decided per session by the relay
 * (server.ts) and handed to {@link relayToolResult}; absent means the MCP default layout.
 */
export interface RelayResultOptions {
  /**
   * The client shows its model `structuredContent` as well as `content` (ChatGPT). `content`
   * then carries the summary line only, so the model reads the result once.
   */
  readonly modelReadsStructuredContent?: boolean;
}

/** Surface slugs (server.ts `surfaceAgentFromClient`) whose model reads structuredContent. */
export const SURFACES_WHOSE_MODEL_READS_STRUCTURED_CONTENT: ReadonlySet<string> = new Set(['chatgpt']);

/**
 * One line describing a result without restating it. Deterministic, so the same result always
 * summarises the same way, and blind to body text: it reports sizes and counts, never values a
 * caller supplied, except an error message the result already carries.
 *
 * `options` says where the full result is, so the line points at it: after the JSON block
 * (the default), or in structuredContent when that is the only copy.
 */
export function summarizeToolResult(name: string, structured: Record<string, unknown>, options: RelayResultOptions = {}): string {
  const label = name || 'result';
  const inStructured = options.modelReadsStructuredContent === true;
  const error = structured['error'];
  if (typeof error === 'string' && error) {
    // Relay errors already begin with the tool name ("read_inbox: forbidden …"); say it once.
    const own = `${label}:`;
    const text = error.startsWith(own) ? error.slice(own.length).trimStart() : error;
    const message = typeof structured['message'] === 'string' ? `: ${structured['message']}` : '';
    return clip(`${label} did not complete — ${text || error}${message}`);
  }
  // A followed affordance: report the exchange, not the response body.
  const status = structured['status'];
  const affordance = structured['affordance'] as Record<string, unknown> | undefined;
  if (typeof status === 'number' && typeof structured['body'] === 'string' && affordance && typeof affordance === 'object') {
    const bytes = Buffer.byteLength(structured['body'] as string);
    const type = typeof structured['contentType'] === 'string' ? structured['contentType'] as string : 'no content type';
    const method = typeof affordance['method'] === 'string' ? `${affordance['method']} ` : '';
    const target = typeof affordance['target'] === 'string' ? affordance['target'] : 'the target';
    return clip(`${label}: ${method}${target} answered ${status}${structured['statusText'] ? ` ${structured['statusText']}` : ''}; `
      + `the ${bytes.toLocaleString('en-US')}-byte ${type} response is the body field of ${inStructured ? 'structuredContent' : 'the JSON result'}.`);
  }
  // A paged list (read_inbox): say how much is here and whether there is more.
  if (Array.isArray(structured['items']) && typeof structured['total'] === 'number') {
    const shown = (structured['items'] as unknown[]).length;
    const more = structured['hasMore'] === true ? ' More are available: pass before = nextCursor.' : '';
    const noun = name === 'read_inbox' ? 'notification' : 'item';
    return clip(`${label}: ${shown} of ${plural(structured['total'] as number, noun)}, newest first.${more}`);
  }
  if (typeof structured['result'] === 'string') {
    const length = (structured['result'] as string).length.toLocaleString('en-US');
    return clip(inStructured
      ? `${label}: text result of ${length} characters, in the result field of structuredContent.`
      : `${label}: text result of ${length} characters (above).`);
  }
  const arrays = Object.entries(structured)
    .filter(([key, value]) => Array.isArray(value) && !key.startsWith('@') && key !== 'affordances')
    .map(([key, value]) => `${key}: ${(value as unknown[]).length}`);
  const fields = Object.keys(structured).filter(key => !key.startsWith('@')).length;
  return clip(`${label}: JSON result ${inStructured ? 'in structuredContent' : 'above'} with ${plural(fields, 'field')}`
    + `${arrays.length ? ` (list sizes ${arrays.slice(0, 3).join(', ')})` : ''}.`);
}

/**
 * Build the envelope from a handler's output. `text` is kept VERBATIM as the back-compat copy
 * (handlers that emit human-readable text keep it); structuredContent is its parsed, null-free
 * object form via the core helper every Interego MCP surface shares. With
 * `modelReadsStructuredContent`, `text` is not sent: structuredContent is the one copy.
 */
export function relayToolResult(
  name: string, text: string, structured: Record<string, unknown> = toStructuredContent(text), options: RelayResultOptions = {},
): RelayToolResult {
  const summary: Text = { type: 'text', text: summarizeToolResult(name, structured, options) };
  return {
    content: options.modelReadsStructuredContent === true ? [summary] : [{ type: 'text', text }, summary],
    structuredContent: structured,
  };
}
