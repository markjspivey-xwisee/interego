/**
 * @module affordance/follow
 * @description Substrate primitive — generic affordance follower.
 *
 * Architectural intent (CLAUDE.md "Path A"): a vertical's capabilities
 * travel as `iep:Affordance` blocks on its Context Descriptors. Each
 * block carries:
 *   - `iep:action  <urn:iep:action:foxxi:discover-assigned-courses>` — the
 *     canonical action IRI a caller selects by
 *   - `hydra:target <https://…/foxxi/discover_assigned_courses>` — the
 *     HTTP endpoint to invoke
 *   - `hydra:method "POST"` — the HTTP verb (default POST if absent)
 *   - optionally `dcat:mediaType "application/json"` — what the
 *     endpoint returns
 *
 * `followAffordance` fetches the descriptor at `descriptorUrl`, parses
 * its affordance blocks with the project's TriG/Turtle parser
 * (`parseTrig` — no runtime deps), locates the affordance matching
 * `actionIri`, and POSTs the caller-supplied JSON payload to its
 * `hydra:target`. The structured result echoes the resolved
 * affordance + the raw HTTP response so the caller can parse based on
 * `contentType` and decide whether a 4xx is informative or fatal.
 *
 * This is a substrate-level primitive — it introduces no new ontology
 * term and is independent of any particular vertical. The Interego MCP
 * servers expose it as the generic `invoke_affordance` tool so a single
 * connector can reach any vertical's affordances without installing the
 * vertical's own MCP bridge. Per-vertical bridges continue to work
 * AS-IS — this is purely additive.
 *
 * NOTE: this is distinct from the "memory affordance" `followAffordance`
 * in `integrations/openclaw-memory/src/bridge.ts`, which is a semantic-
 * verb dispatcher (read / derive / retract / …) over the memory-shaped
 * subset of the substrate. This one is the generic protocol-level
 * follower over the wider affordance surface.
 *
 * History: lived under `solid/affordance.ts` while the substrate
 * extraction was in flight. Solid is one binding among many; the
 * follower is binding-agnostic and lives in `affordance/` now.
 */

import type { IRI } from '../model/types.js';
import type { FetchFn, FetchResponse } from '../http/types.js';
import { getDefaultFetch } from '../http/fetch.js';
import { withTransientRetry } from '../http/retry.js';
import {
  parseTrig,
  findSubjectsOfType,
  readIriValue,
  readStringValue,
} from '../rdf/turtle-parser.js';
import { CG, IEH, CGH_LEGACY, HYDRA, DCAT } from '../rdf/namespaces.js';

// ── Error types ──────────────────────────────────────────────

/**
 * Thrown when the descriptor URL cannot be fetched (404 / non-2xx).
 * Distinct from network-transient errors — caller cannot proceed
 * without a descriptor to read.
 */
export class DescriptorNotFoundError extends Error {
  constructor(public readonly descriptorUrl: string, public readonly status: number) {
    super(`Descriptor not found: ${descriptorUrl} (HTTP ${status})`);
    this.name = 'DescriptorNotFoundError';
  }
}

/**
 * Thrown when the descriptor exists but has no `iep:Affordance` matching
 * the requested `actionIri`. The error message lists the affordance
 * action IRIs actually present, so the caller can pick the right one or
 * report back to the user.
 */
export class AffordanceNotFoundError extends Error {
  constructor(
    public readonly descriptorUrl: string,
    public readonly actionIri: string,
    public readonly availableActions: readonly string[],
  ) {
    const list = availableActions.length > 0
      ? availableActions.map(a => `  - ${a}`).join('\n')
      : '  (none — descriptor declares no iep:Affordance blocks)';
    super(
      `No iep:Affordance with iep:action <${actionIri}> in descriptor ${descriptorUrl}.\n`
      + `Available actions:\n${list}`,
    );
    this.name = 'AffordanceNotFoundError';
  }
}

// ── Public types ─────────────────────────────────────────────

/** HTTP methods we'll accept on `hydra:method`. */
export type AffordanceMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Options for {@link followAffordance}. */
export interface FollowAffordanceOptions {
  /** Optional fetch implementation; defaults to the global `fetch`. */
  readonly fetch?: FetchFn;
  /** Optional `Authorization` header value to forward verbatim
   *  (e.g. `Bearer <token>`). Not auto-derived from any caller context;
   *  supply it explicitly when the target requires auth. */
  readonly authorization?: string;
  /** When set, the resolved `hydra:method` must match. Useful as a
   *  client-side sanity check before invoking. */
  readonly expectedMethod?: AffordanceMethod;
}

/** The affordance metadata resolved from the descriptor. */
export interface ResolvedAffordance {
  /** The `iep:action` IRI (echo of the caller's selector). */
  readonly action: string;
  /** The `hydra:target` URL the payload was POSTed to. */
  readonly target: string;
  /** The resolved `hydra:method` (default `POST` when absent). */
  readonly method: string;
  /** The `dcat:mediaType` when present. */
  readonly mediaType?: string;
}

/** The result of following an affordance. */
export interface FollowAffordanceResult {
  /** Numeric HTTP status from the target. */
  readonly status: number;
  /** HTTP status text. */
  readonly statusText: string;
  /** `Content-Type` header reported by the target, when present. */
  readonly contentType: string | null;
  /** Raw response body — caller decides whether to JSON.parse based on
   *  `contentType`. */
  readonly body: string;
  /** Resolved affordance details — useful for logging + debugging. */
  readonly affordance: ResolvedAffordance;
}

// ── Implementation ───────────────────────────────────────────

/** RDF type IRIs we accept as marking a block as an affordance. */
const AFFORDANCE_TYPE_IRIS: readonly IRI[] = [
  `${CG}Affordance` as IRI,
  // The harness namespace mirror — see applications/_shared/affordance-mcp/index.ts
  `${IEH}Affordance` as IRI,
  // Deprecated read-alias: data persisted while the kernel emitted the
  // never-published ns/cgh# IRI still carries this type in its (signed) bytes.
  `${CGH_LEGACY}Affordance` as IRI,
  `${HYDRA}Operation` as IRI,
];

const CG_ACTION = `${CG}action` as IRI;
const HYDRA_TARGET = `${HYDRA}target` as IRI;
const HYDRA_METHOD = `${HYDRA}method` as IRI;
const DCAT_MEDIA_TYPE = `${DCAT}mediaType` as IRI;

/**
 * Generic affordance follower.
 *
 * 1. Fetches the descriptor at `descriptorUrl` (Turtle/TriG).
 * 2. Parses it with `parseTrig` and collects every subject typed as
 *    `iep:Affordance`, `ieh:Affordance`, or `hydra:Operation` —
 *    descriptors often type a block as more than one of these and
 *    `findSubjectsOfType` is single-typed, so we union the candidates.
 * 3. Matches by `iep:action == actionIri`.
 * 4. Reads `hydra:target` (required) and `hydra:method` (default POST).
 *    Verifies against `expectedMethod` if supplied.
 * 5. POSTs `payload` as `application/json` to the target. Forwards
 *    `authorization` when present.
 * 6. Returns the structured result above. 4xx is returned to the
 *    caller as data (informative — e.g. `forbidden`); transient network
 *    errors are retried by `withTransientRetry` before surfacing.
 */
export async function followAffordance(
  descriptorUrl: string,
  actionIri: string,
  payload: unknown,
  options?: FollowAffordanceOptions,
): Promise<FollowAffordanceResult> {
  const fetchImpl = options?.fetch ?? getDefaultFetch();

  // ── 1. Fetch the descriptor ──────────────────────────────
  const descriptorBody = await withTransientRetry(async () => {
    const r = await fetchImpl(descriptorUrl, {
      headers: { Accept: 'text/turtle, application/trig, */*' },
    });
    if (r.status === 404 || r.status === 410) {
      throw new DescriptorNotFoundError(descriptorUrl, r.status);
    }
    if (!r.ok) {
      throw new Error(`Failed to fetch descriptor ${descriptorUrl}: ${r.status} ${r.statusText}`);
    }
    return r.text();
  });

  // ── 2. Parse + collect candidate affordance subjects ─────
  //
  // First try a full-document parse — succeeds on a single-affordance
  // descriptor or any clean multi-affordance descriptor. If the document
  // contains a malformed block (e.g. a bridge with a half-rendered
  // affordance), full-doc parse can throw — at which point we fall
  // back to extracting just the targeted affordance's block by IRI
  // anchor and parsing that slice. This keeps followAffordance robust
  // against neighbor-block slop on bulk affordance manifests without
  // weakening the substrate TriG parser (which is intentionally strict
  // for typed-descriptor extraction).
  let candidates: ReadonlyArray<ReturnType<typeof findSubjectsOfType>[number]> = [];
  let fullParseFailed = false;
  try {
    const doc = parseTrig(descriptorBody);
    const candidateMap = new Map<string, typeof doc.subjects[number]>();
    for (const typeIri of AFFORDANCE_TYPE_IRIS) {
      for (const s of findSubjectsOfType(doc, typeIri)) {
        const key = typeof s.subject === 'string' ? s.subject : `_:${s.subject.bnode}`;
        if (!candidateMap.has(key)) candidateMap.set(key, s);
      }
    }
    candidates = Array.from(candidateMap.values());
  } catch {
    fullParseFailed = true;
  }

  // ── 3. Find the one whose iep:action == actionIri ─────────
  const available: string[] = [];
  let match: typeof candidates[number] | undefined;
  for (const c of candidates) {
    const action = readIriValue(c, CG_ACTION);
    if (action) {
      available.push(action);
      if (action === actionIri) {
        match = c;
        break;
      }
    }
  }

  // Fallback: full-doc parse failed OR the target wasn't in the
  // successfully-parsed subjects (e.g. it appears as an inline
  // blank-node nested inside another subject the parser handled
  // differently). Try a targeted slice + reparse anchored on
  // `<actionIri>`. We extract the smallest leading slice that contains
  // the affordance's full property list — up to the next top-level
  // `.` (Turtle triple terminator) after the anchor.
  if (!match) {
    const sliced = extractAffordanceSlice(descriptorBody, actionIri);
    if (sliced) {
      try {
        const subDoc = parseTrig(sliced);
        for (const typeIri of AFFORDANCE_TYPE_IRIS) {
          for (const s of findSubjectsOfType(subDoc, typeIri)) {
            const action = readIriValue(s, CG_ACTION);
            if (action === actionIri) {
              match = s;
              if (!available.includes(action)) available.push(action);
              break;
            }
          }
          if (match) break;
        }
      } catch {
        // Slice also malformed — fall through to the not-found error.
      }
    }
  }
  if (!match) {
    if (fullParseFailed && available.length === 0) {
      throw new Error(
        `Descriptor ${descriptorUrl} could not be fully parsed AND no affordance slice anchored on <${actionIri}> was extractable. Verify the descriptor URL points at valid Turtle/TriG and the action IRI matches a iep:Affordance subject in the document.`,
      );
    }
    throw new AffordanceNotFoundError(descriptorUrl, actionIri, available);
  }

  // ── 4. Resolve target + method + mediaType ───────────────
  const target = readIriValue(match, HYDRA_TARGET);
  if (!target) {
    throw new Error(
      `Affordance ${actionIri} in ${descriptorUrl} is missing hydra:target — cannot invoke.`,
    );
  }
  const methodRaw = readStringValue(match, HYDRA_METHOD);
  const method = (methodRaw ?? 'POST').toUpperCase() as AffordanceMethod;
  if (options?.expectedMethod && method !== options.expectedMethod) {
    throw new Error(
      `Affordance ${actionIri} declares hydra:method "${method}" but caller expected "${options.expectedMethod}".`,
    );
  }
  const mediaType = readStringValue(match, DCAT_MEDIA_TYPE);

  const resolved: ResolvedAffordance = mediaType
    ? { action: actionIri, target, method, mediaType }
    : { action: actionIri, target, method };

  // ── 5. Invoke the target ─────────────────────────────────
  // Send the affordance's declared dcat:mediaType as the request Content-Type,
  // not a hardcoded application/json — otherwise a body the affordance declares
  // as e.g. application/ld+json is stored under the wrong type (CSS then refuses
  // to serve it as ld+json, and a strict reader never surfaces it: the sender
  // half of f-ldn-inbox-asymmetry). Affordances that declare no mediaType keep
  // application/json, so existing JSON affordances are unchanged.
  const headers: Record<string, string> = {
    'Content-Type': mediaType ?? 'application/json',
    'Accept': mediaType ?? 'application/json, */*',
  };
  if (options?.authorization) {
    headers['Authorization'] = options.authorization;
  }

  // GET/HEAD requests MUST NOT carry a body — the Fetch spec throws
  // "Request with GET/HEAD method cannot have body", so omit it for safe methods
  // regardless of any supplied payload (an HMD read-control invoked with the
  // schema-required `{}` payload would otherwise fail before reaching the target).
  // For body-bearing methods, serialize exactly once — a payload that is already a
  // JSON string is sent as-is (see f-act-payload-double-encode); only an object is
  // stringified.
  const bodyless = method === 'GET';
  const hasPayload = payload !== undefined && payload !== null;
  const body = (!bodyless && hasPayload) ? (typeof payload === 'string' ? payload : JSON.stringify(payload)) : undefined;

  const response = await withTransientRetry(async () => {
    const r = await fetchImpl(target, { method, headers, body });
    // 5xx is transient — let withTransientRetry retry. 4xx is informative
    // (caller wants to see "forbidden" / "validation failed"), so we
    // surface it as data, not an exception.
    if (r.status >= 500) {
      throw new Error(`Affordance target ${target} returned ${r.status} ${r.statusText}`);
    }
    return r;
  });

  const responseBody = await response.text();
  // FetchResponse intentionally doesn't expose headers as a typed map —
  // probe via the underlying `.headers.get` when present (Node fetch /
  // browser fetch), fall back to undefined otherwise.
  const contentType = readContentType(response);

  return {
    status: response.status,
    statusText: response.statusText,
    contentType,
    body: responseBody,
    affordance: resolved,
  };
}

/** Best-effort Content-Type read — `FetchResponse.headers` is optional so
 *  some adapters may omit it; fall back to null when absent. */
function readContentType(response: FetchResponse): string | null {
  return response.headers?.get('content-type') ?? null;
}

/**
 * Extract the smallest leading slice of `descriptorBody` that contains
 * the affordance block anchored on `<actionIri>` so a malformed neighbor
 * elsewhere in the document doesn't poison the parse. Returns the
 * concatenation of:
 *   - every `@prefix` directive at the top of the file (the slice may
 *     reference prefixed names), and
 *   - the substring from the line that starts with `<actionIri>` up to
 *     and including the next top-level `.` triple terminator.
 *
 * Returns null if no anchor line is found.
 *
 * Note: this is a deliberately small, line-oriented heuristic. It is
 * not a parser — it just bounds the input we hand to `parseTrig`. The
 * substrate parser still does all the real work on the slice.
 */
function extractAffordanceSlice(descriptorBody: string, actionIri: string): string | null {
  const anchor = `<${actionIri}>`;
  // The IRI may appear multiple times in the document (e.g. as an object
  // inside a hydra:Collection's `iep:affordance` list AND as the subject
  // of the affordance block itself). We want the occurrence where it
  // appears AS A SUBJECT — characterized by being at the start of a line
  // (possibly after whitespace) AND immediately followed by a predicate.
  // Pragmatic heuristic: scan every occurrence, keep the first one
  // whose preceding non-whitespace character on its own line is a
  // newline (i.e., the anchor opens a fresh statement).
  let anchorIdx = -1;
  let search = 0;
  while (search < descriptorBody.length) {
    const idx = descriptorBody.indexOf(anchor, search);
    if (idx === -1) break;
    // Walk backward to the previous non-whitespace; if it's a newline
    // or we hit start-of-document, the anchor is at statement start.
    let probe = idx - 1;
    while (probe >= 0 && (descriptorBody[probe] === ' ' || descriptorBody[probe] === '\t')) probe--;
    if (probe < 0 || descriptorBody[probe] === '\n') {
      anchorIdx = idx;
      break;
    }
    search = idx + anchor.length;
  }
  if (anchorIdx === -1) return null;

  // Walk back to the start of the line containing the anchor — Turtle
  // subjects can have leading whitespace.
  let blockStart = anchorIdx;
  while (blockStart > 0 && descriptorBody[blockStart - 1] !== '\n') blockStart--;

  // Walk forward to the first `.` at the top level (i.e., not inside
  // `[...]` or `"..."`). This is the smallest correct termination for
  // the affordance's property list.
  let i = anchorIdx;
  let depth = 0;
  let inString = false;
  let tripleQuoted = false;
  let inIri = false;
  // Turtle uses double-quote strings only (no single-quote literals as
  // in some other RDF dialects); apostrophes inside text MUST not be
  // treated as string delimiters or our slice would absorb the rest of
  // the document. IRIs (`<…>`) routinely contain `.` (URL hostnames),
  // so we track them too — a slice terminator `.` must appear OUTSIDE
  // any IRI, string, or blank-node/group.
  while (i < descriptorBody.length) {
    const c = descriptorBody[i]!;
    if (inIri) {
      if (c === '>') inIri = false;
      i++;
      continue;
    }
    if (inString) {
      if (c === '\\' && i + 1 < descriptorBody.length) {
        i += 2;
        continue;
      }
      if (tripleQuoted) {
        if (c === '"' && descriptorBody.slice(i, i + 3) === '"""') {
          inString = false;
          tripleQuoted = false;
          i += 3;
          continue;
        }
      } else if (c === '"') {
        inString = false;
      }
      i++;
      continue;
    }
    if (c === '<') {
      inIri = true;
      i++;
      continue;
    }
    if (c === '"') {
      if (descriptorBody.slice(i, i + 3) === '"""') {
        tripleQuoted = true;
        inString = true;
        i += 3;
        continue;
      }
      inString = true;
      i++;
      continue;
    }
    if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') depth--;
    else if (c === '.' && depth === 0) {
      // Found the top-level terminator.
      const blockEnd = i + 1;
      // Prepend every @prefix line from the original document so the
      // sliced parse can resolve prefixed names.
      const prefixLines = collectPrefixDirectives(descriptorBody);
      return `${prefixLines}\n${descriptorBody.slice(blockStart, blockEnd)}\n`;
    }
    i++;
  }
  return null;
}

/** Collect every `@prefix … .` line at the top of a Turtle document. */
function collectPrefixDirectives(src: string): string {
  const lines = src.split('\n');
  const out: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith('@prefix') || trimmed.startsWith('@base')
        || trimmed.startsWith('PREFIX') || trimmed.startsWith('BASE')) {
      out.push(line);
      continue;
    }
    // First non-directive content line — stop scanning.
    break;
  }
  return out.join('\n');
}
