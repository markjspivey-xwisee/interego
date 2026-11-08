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
 * whose report started this, so for a session the relay identifies as ChatGPT
 * {@link relayToolResult} leaves the JSON copy out of `content` and sends the summary line
 * alone. structuredContent is unchanged, so ChatGPT's model and its widget (`toolOutput`)
 * read the result once. Every other client keeps the JSON first.
 *
 * What "read the result" means there: structuredContent is the parsed result WITHOUT its
 * null-valued fields (toStructuredContent omits them, so a declared `"type": "string"` is never
 * handed a null). `{ "meet": null, "message": "…" }` reaches ChatGPT's model as the message
 * alone; the null is said by the field being absent, not by a value.
 *
 * An error keeps its JSON in `content` for ChatGPT too: a top-level `error`, or a failed
 * interaction the caller marks isError. Error bodies are small, the summary line cannot carry a
 * nested reason, and a client that reports isError from `content` alone must still see why.
 *
 * ★ IDENTIFICATION IS NARROW, because the two mistakes are not alike. The default layout given
 * to ChatGPT costs bytes; the summary-only layout given to a client whose model reads `content`
 * alone loses the whole result, silently. A client NAMES itself at registration, and a name is
 * only a claim: "my ChatGPT bridge" is a fine name for a client of the second kind. So the relay
 * requires the name AND every redirect URI the client registered to be on that surface's own
 * hosts ({@link SURFACES_WHOSE_MODEL_READS_STRUCTURED_CONTENT}). The authorization code is
 * delivered to a registered redirect URI, so a client that is not ChatGPT cannot finish sign-in
 * with redirect URIs that only ChatGPT receives. The deployment's default surface
 * (RELAY_DEFAULT_SURFACE_AGENT) is never consulted for this.
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

/**
 * Surface slugs (server.ts `SURFACE_PATTERNS`) whose model reads structuredContent, each with the
 * hosts its OAuth redirect URIs are on. A host covers its subdomains. ChatGPT's connector
 * redirect is on chatgpt.com, and OpenAI's own app tooling redirects to openai.com hosts.
 */
export const SURFACES_WHOSE_MODEL_READS_STRUCTURED_CONTENT: ReadonlyMap<string, readonly string[]> = new Map([
  ['chatgpt', ['chatgpt.com', 'openai.com']],
]);

/** The fields of a registered OAuth client (RFC 7591 metadata) the layout decision reads. */
export interface RegisteredClient {
  readonly client_name?: string;
  readonly redirect_uris?: readonly unknown[];
}

/** Every URI is https on one of `hosts` or a subdomain of one. No URIs at all is not. */
function redirectsOnlyTo(uris: readonly unknown[] | undefined, hosts: readonly string[]): boolean {
  if (!Array.isArray(uris) || uris.length === 0) return false;
  return uris.every((uri) => {
    if (typeof uri !== 'string') return false;
    let url: URL;
    try { url = new URL(uri); } catch { return false; }
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:' && hosts.some(h => host === h || host.endsWith(`.${h}`));
  });
}

/**
 * The layout for one registered client. `surfaceOfName` maps a client name to a surface slug by
 * the surface patterns alone, and answers undefined for a name they do not match: never the
 * deployment's default surface, which says nothing about the client. A client gets the
 * structuredContent layout only when its name maps to such a surface AND every redirect URI it
 * registered is on that surface's hosts. Anything less gets the default layout.
 */
export function resultOptionsForRegisteredClient(
  client: RegisteredClient | undefined, surfaceOfName: (name: string) => string | undefined,
): RelayResultOptions {
  const name = typeof client?.client_name === 'string' ? client.client_name.trim() : '';
  if (!name) return {};
  const surface = surfaceOfName(name);
  const hosts = surface === undefined ? undefined : SURFACES_WHOSE_MODEL_READS_STRUCTURED_CONTENT.get(surface);
  return hosts && redirectsOnlyTo(client?.redirect_uris, hosts) ? { modelReadsStructuredContent: true } : {};
}

/**
 * The layout for each OAuth client id, remembered for a while so a tools/call does not cost a
 * client lookup. Without it, every call by a token whose client is no longer registered repeated
 * the store's read-through GET (the store keeps hits, not misses), and a client identified by a
 * metadata document refetched it whenever the store's copy expired.
 *
 * A known client's answer is kept for `ttlMs`, an unknown client's for the shorter `missTtlMs`;
 * a lookup that THROWS is not remembered, so a store outage is retried. At most `maxEntries`
 * ids are held, oldest dropped first. Any failure answers the default layout.
 */
export function resultOptionsResolver(
  lookup: (clientId: string) => Promise<RegisteredClient | undefined> | RegisteredClient | undefined,
  surfaceOfName: (name: string) => string | undefined,
  { ttlMs = 10 * 60_000, missTtlMs = 60_000, maxEntries = 1024, now = Date.now }:
    { ttlMs?: number; missTtlMs?: number; maxEntries?: number; now?: () => number } = {},
): (clientId: string | undefined) => Promise<RelayResultOptions> {
  const remembered = new Map<string, { options: RelayResultOptions; until: number }>();
  return async (clientId) => {
    if (!clientId) return {};
    const kept = remembered.get(clientId);
    if (kept && kept.until > now()) return kept.options;
    let client: RegisteredClient | undefined;
    try { client = await lookup(clientId); } catch { return {}; }
    const options = resultOptionsForRegisteredClient(client, surfaceOfName);
    remembered.delete(clientId);
    while (remembered.size >= maxEntries) remembered.delete(remembered.keys().next().value as string);
    remembered.set(clientId, { options, until: now() + (client ? ttlMs : missTtlMs) });
    return options;
  };
}

/** A result that reports a failure: a non-empty top-level `error`. */
function reportsError(structured: Record<string, unknown>): boolean {
  return typeof structured['error'] === 'string' && structured['error'] !== '';
}

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
 * `modelReadsStructuredContent`, `text` is not sent and structuredContent is the one copy,
 * except for an error, which keeps its JSON in content for every client (see the header).
 */
export function relayToolResult(
  name: string, text: string, structured: Record<string, unknown> = toStructuredContent(text), options: RelayResultOptions = {},
): RelayToolResult {
  const oneCopy = options.modelReadsStructuredContent === true && !reportsError(structured);
  const summary: Text = { type: 'text', text: summarizeToolResult(name, structured, oneCopy ? options : {}) };
  return {
    content: oneCopy ? [summary] : [{ type: 'text', text }, summary],
    structuredContent: structured,
  };
}
