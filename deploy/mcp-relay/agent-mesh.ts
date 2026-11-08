/**
 * @module agent-mesh
 * @description Agent-to-agent notification + messaging for the Interego
 *              federation, built on Linked Data Notifications (LDN, W3C
 *              Rec) over the Solid pods the relay already manages.
 *
 * Design — relay-mediated LDN:
 *   The W3C LDN flow is "sender POSTs an RDF notification to the target's
 *   ldp:inbox; consumers GET the inbox". Doing that cross-agent directly
 *   would require every pod's inbox to carry a public-append WAC ACL,
 *   which is fiddly to provision safely (a wrong .acl can lock a pod).
 *   Instead the relay mediates: an authenticated sender calls the
 *   `notify_agent` tool, and the relay — which already holds write creds
 *   for every pod it manages — drops the notification into the target's
 *   `inbox/` container, attributing the recovered sender. The LDN
 *   contract (inbox resource + AS2 body + GET-to-consume) is preserved;
 *   only the transport hop is via the relay rather than a public POST.
 *   When ActivityPub federation lands (with HTTP Signatures), the same
 *   inbox accepts signed external POSTs too — the body shape below is
 *   already ActivityStreams 2.0 so no migration is needed.
 *
 * The notification body is ActivityStreams 2.0 (the vocabulary LDN,
 * ActivityPub, and Webmention consumers all understand), so one inbox
 * serves every standard we abstract.
 */

import type { FetchFn } from '@interego/core';

const INBOX_CONTAINER = 'inbox/';
/** The substrate's own resolving vocabulary namespace. */
const IEP_NS = 'https://markjspivey-xwisee.github.io/interego/ns/iep#';

function ensureTrailingSlash(s: string): string {
  return s.endsWith('/') ? s : `${s}/`;
}

export function inboxUrlFor(podUrl: string): string {
  return `${ensureTrailingSlash(podUrl)}${INBOX_CONTAINER}`;
}

function defaultFetch(): FetchFn {
  return (async (url, init) => {
    const r = await fetch(url, init as RequestInit);
    return {
      ok: r.ok, status: r.status, statusText: r.statusText,
      headers: { get: (n: string) => r.headers.get(n) },
      text: () => r.text(), json: () => r.json(),
    };
  }) as FetchFn;
}

const AS2_CONTEXT: Array<string | Record<string, string>> = [
  'https://www.w3.org/ns/activitystreams',
  { iep: 'https://markjspivey-xwisee.github.io/interego/ns/iep#' },   // resolving namespace (was a .example placeholder)
];

export interface NotificationInput {
  /** Sender identity (DID/WebID). */
  readonly from: string;
  /** Recipient identity (DID/WebID). */
  readonly to: string;
  /** AS2 activity type: Create | Announce | Note | Offer | Question | Update. */
  readonly type?: string;
  /** One-line human summary (shows in inbox previews). */
  readonly summary: string;
  /** Free-text body. */
  readonly content?: string;
  /** Optional IRI this notification is about (a descriptor, finding, resolution, graph). */
  readonly about?: string;
  /** Optional IRI this is a reply to. */
  readonly inReplyTo?: string;
  /** ISO-8601 timestamp (caller supplies — relay runtime has Date). */
  readonly published: string;
}

/** Build an ActivityStreams 2.0 notification document. */
export function buildNotification(input: NotificationInput, idSlug: string): Record<string, unknown> {
  const obj: Record<string, unknown> = {
    type: 'Note',
    summary: input.summary,
    ...(input.content ? { content: input.content } : {}),
    ...(input.about ? { 'iep:about': input.about } : {}),
    ...(input.inReplyTo ? { inReplyTo: input.inReplyTo } : {}),
  };
  return {
    '@context': AS2_CONTEXT,
    // Provisional; deliverNotification rewrites this to the resource's OWN url
    // once the target pod is known. Never shipped as-is — see the id assignment there.
    id: idSlug,
    type: input.type ?? 'Create',
    actor: input.from,
    to: [input.to],
    published: input.published,
    summary: input.summary,
    object: obj,
  };
}

/**
 * What the STORE says about a pod root: it holds it, it definitely does not, or this process
 * cannot tell.
 *
 * ★★ ONLY A DEFINITE NO IS A NO. 404 and 410 mean "there is no pod here". Every other
 * answer — 2xx, 401, 403, 405, 5xx, a network error, a timeout — is `'unknown'`, and every
 * reader treats `'unknown'` exactly as it treated the world before this probe existed. The
 * only way to produce a FALSE refusal is for the store to 404 a container it holds, which is
 * a contradiction; a fail-closed rule would instead turn any hiccup on this probe into an
 * outage on delivery and on every published agent identity.
 */
export type PodRootPresence =
  | { exists: true }
  | { exists: false; status: number }
  | { exists: 'unknown'; because: string };

/**
 * Does the pod ROOT at `podRootUrl` already exist on the store — asked of the store itself,
 * before anything writes into it or publishes an identity for it.
 *
 * ★ ASKED OF THE SPELLING THE WRITE WILL USE. Callers pass the internal URL, so the thing
 * probed and the thing written are the same resource rather than two that usually agree.
 */
export async function podRootPresence(
  podRootUrl: string,
  fetchFn: FetchFn = defaultFetch(),
): Promise<PodRootPresence> {
  try {
    const r = await fetchFn(podRootUrl, { method: 'HEAD' });
    if (r.status === 404 || r.status === 410) return { exists: false, status: r.status };
    if (r.ok) return { exists: true };
    return { exists: 'unknown', because: `the store answered ${r.status} ${r.statusText}` };
  } catch (err) {
    return { exists: 'unknown', because: `the probe failed: ${(err as Error).message}` };
  }
}

/**
 * Deliver a notification into a target pod's LDN inbox. The relay's
 * fetch (service creds) writes the file. Returns the notification URL, or null on
 * failure (best-effort — delivery failures never fail the caller).
 *
 * ── ★★ THE WRITE ITSELF REFUSES TO MANUFACTURE ITS DESTINATION ──────────────────────────────
 *
 * CSS auto-creates a container on first PUT, and this is a PUT to
 * `<pod>/inbox/<slug>.jsonld`. So for as long as this function would write wherever it was
 * pointed, "does that pod exist" was a question each CALLER had to remember to ask — and 96d89dc4
 * closed it at `handleNotifyAgent` while `POST /agents/:localPart/inbox`, the other caller, kept
 * calling straight through. A gate in front of one of two callers is the mistake this area keeps
 * making, so the refusal is HERE, at the function that owns the credential and the PUT: a third
 * caller cannot reintroduce it by not knowing about it.
 *
 * ★ `presence` IS AN ANSWER ALREADY OBTAINED, NOT A PERMISSION TO SKIP THE QUESTION.
 * `handleNotifyAgent` must decide BEFORE its channel fan-out — a refusal after the Discord and
 * Telegram adapters have run would refuse a message the recipient has already been shown — so it
 * probes above them and hands the answer down here. That keeps the cost at exactly one HEAD per
 * send, the figure 96d89dc4 measured, instead of two. A caller that passes nothing is probed.
 */
export async function deliverNotification(
  targetPodUrl: string,
  notif: Record<string, unknown>,
  idSlug: string,
  fetchFn: FetchFn = defaultFetch(),
  log: (m: string) => void = () => {},
  presence?: PodRootPresence,
): Promise<string | null> {
  const known = presence ?? await podRootPresence(targetPodUrl, fetchFn);
  if (known.exists === false) {
    log(`[agent-mesh] deliver refused: the store answered ${known.status} for the pod root `
      + `"${targetPodUrl}", so there is no pod to deliver to and nothing was written`);
    return null;
  }
  const url = `${inboxUrlFor(targetPodUrl)}${idSlug}.jsonld`;
  // EVERYTHING IS A URL: the notification's id IS the resource it becomes. This was
  // previously `urn:interego:notif:<slug>` — an identifier that dereferenced to
  // nothing, in every notification the substrate delivered. buildNotification cannot
  // mint it (it does not know the target pod); this is the first point that does.
  notif['id'] = url;
  try {
    const r = await fetchFn(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/ld+json' },
      body: JSON.stringify(notif, null, 2),
    });
    if (!r.ok) { log(`[agent-mesh] deliver PUT ${url} -> ${r.status} ${r.statusText}`); return null; }
    log(`[agent-mesh] delivered notification to ${url}`);
    return url;
  } catch (err) {
    log(`[agent-mesh] deliver(${url}) failed: ${(err as Error).message}`);
    return null;
  }
}

/** Enumerate EVERY member of a pod's inbox LDP container (ldp:contains).
 *  W3C LDN §"consuming": a consumer lists the inbox container and fetches each
 *  member regardless of its file name or stored content type. The old impl only
 *  matched `<…>.jsonld`, so a spec-pure LDN POST from a foreign sender (which CSS
 *  stores UUID-named + application/json when the sender's Content-Type wasn't
 *  ld+json) was invisible — the f-ldn-inbox-asymmetry defect. */
async function listInbox(podUrl: string, fetchFn: FetchFn): Promise<string[]> {
  const containerUrl = inboxUrlFor(podUrl);
  try {
    const r = await fetchFn(containerUrl, { method: 'GET', headers: { Accept: 'text/turtle' } });
    if (!r.ok) return [];
    const body = await r.text();
    const urls = new Set<string>();
    const add = (ref: string) => { try { const u = new URL(ref, containerUrl).toString(); if (u !== containerUrl) urls.add(u); } catch { /* skip */ } };
    // Primary: the objects of ldp:contains (the authoritative member list).
    const containsRe = /(?:ldp:contains|<http:\/\/www\.w3\.org\/ns\/ldp#contains>)\s+([^.]+?)\s*\./g;
    let cm: RegExpExecArray | null;
    while ((cm = containsRe.exec(body)) !== null) {
      const refRe = /<([^>\s]+)>/g; let rm: RegExpExecArray | null;
      while ((rm = refRe.exec(cm[1]!)) !== null) add(rm[1]!);
    }
    // Fallback: if the container didn't expose a parseable contains block, match
    // any member-shaped token — a jsonld/json file OR a bare UUID.
    if (urls.size === 0) {
      const re = /<([^>\s]*(?:\.jsonld|\.json|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})[^>\s]*)>/gi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(body)) !== null) add(m[1]!);
    }
    return [...urls];
  } catch { return []; }
}

/**
 * One inbox notification as the relay reports it. Every field is a string, and that is a
 * guarantee, not a hope: {@link inboxItemFrom} is the only place an item is made, and it drops
 * any value it cannot read as a string. `read_inbox` declares these fields as strings in its
 * outputSchema, and a client that checks results against that schema rejects the WHOLE page
 * for one notification whose `actor` is an object.
 */
export interface InboxItem {
  url: string;
  id?: string;
  type?: string;
  actor?: string;
  summary?: string;
  content?: string;
  about?: string;
  published?: string;
}

// ── Reading a stored notification ──────────────────────────────────────────
//
// ★ A NOTIFICATION IS WRITTEN BY ITS SENDER, NOT BY THIS RELAY. `notify_agent` writes the
// relay's own flat shape, but the inbox also holds what other senders deliver straight to the
// store (see listInbox) and what `act` stores. ActivityStreams lets `actor` be an object
// ({id, type, name}), `type` an array (["Create", "<extension IRI>"]), and JSON-LD lets any
// literal be a value object ({"@value": …}). These read each such field as one string, or
// leave it out.

/** A literal: a string, or the string inside a JSON-LD value object. */
function textOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const inner = (value as Record<string, unknown>)['@value'];
    if (typeof inner === 'string') return inner;
  }
  return undefined;
}

/** A reference: a string, or the `id` / `@id` of an embedded object. */
function referenceOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const v = value as Record<string, unknown>;
    if (typeof v['id'] === 'string') return v['id'];
    if (typeof v['@id'] === 'string') return v['@id'];
  }
  return undefined;
}

/**
 * An activity type. For an array, the first plain string in it: senders list the
 * ActivityStreams type first and extension types after it, and callers compare the type with
 * `=== 'Offer'`, which a joined string would never satisfy.
 */
function typeOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.find((entry): entry is string => typeof entry === 'string');
  return undefined;
}

/** A `published` literal: as {@link textOf}, except that an empty string names no time. */
function dateTextOf(value: unknown): string | undefined {
  const text = textOf(value);
  return text === '' ? undefined : text;
}

/** The first candidate that reads as a string. */
function first(read: (value: unknown) => string | undefined, ...candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    const value = read(candidate);
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * The one way an inbox item is made from a stored notification. Every field is a string or is
 * absent. Exported so the field rules are tested without a pod.
 */
export function inboxItemFrom(url: string, stored: unknown): InboxItem | null {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return null;
  const d = stored as Record<string, unknown>;
  const obj = d['object'] && typeof d['object'] === 'object' && !Array.isArray(d['object'])
    ? d['object'] as Record<string, unknown> : {};
  const item: InboxItem = { url };
  const fields: Array<[Exclude<keyof InboxItem, 'url'>, string | undefined]> = [
    ['id', first(referenceOf, d['id'], d['@id'])],
    ['type', first(typeOf, d['type'], d['@type'])],
    ['actor', first(referenceOf, d['actor'])],
    ['summary', first(textOf, d['summary'], obj['summary'])],
    ['content', first(textOf, obj['content'], d['content'])],
    ['about', first(referenceOf, obj['iep:about'], obj[`${IEP_NS}about`], obj['interego:about'],
      obj['https://interego-emergent.example/ns/mcp-relay#about'], d['iep:about'], d['interego:about'], d['about'])],
    // An empty `published` names no time, so it is left out like a missing one. ★ It must be:
    // the cursor writes a missing `published` as '' and reads '' back as missing, so an item that
    // kept '' would sort in one place and be found by its cursor in another, and the page after
    // it would skip items (see compareInboxItems).
    ['published', first(dateTextOf, d['published'])],
  ];
  for (const [key, value] of fields) if (value !== undefined) item[key] = value;
  return item;
}

/**
 * Read + parse a pod's inbox, newest-first. Best-effort: unreadable
 * items are skipped. `limit` caps how many are returned.
 */
export async function readInbox(
  podUrl: string,
  fetchFn: FetchFn = defaultFetch(),
  limit = 50,
): Promise<InboxItem[]> {
  return (await readAllInboxItems(podUrl, fetchFn)).slice(0, limit);
}

/** Every readable item of a pod's inbox, in {@link compareInboxItems} order. */
export async function readAllInboxItems(podUrl: string, fetchFn: FetchFn = defaultFetch()): Promise<InboxItem[]> {
  const urls = await listInbox(podUrl, fetchFn);
  const items: InboxItem[] = [];
  await Promise.allSettled(urls.map(async url => {
    try {
      // Tolerate ANY stored type: a spec-pure LDN POST may be stored as
      // application/json, which CSS refuses to convert to ld+json (it 4xxs).
      // Ask for both, parse the JSON either way, and unwrap a double-encoded
      // JSON string (an act-stored body is a JSON-encoded string of the AS2 doc).
      const r = await fetchFn(url, { method: 'GET', headers: { Accept: 'application/ld+json, application/json;q=0.9, */*;q=0.1' } });
      if (!r.ok) return;
      let d: any = JSON.parse(await r.text());
      if (typeof d === 'string') { try { d = JSON.parse(d); } catch { /* keep as-is */ } }
      if (Array.isArray(d)) d = d.find((x: any) => x && typeof x === 'object' && (x.type || x.summary || x.object)) ?? d[0] ?? {};
      const item = inboxItemFrom(url, d);
      if (item) items.push(item);
    } catch { /* skip */ }
  }));
  items.sort(compareInboxItems);
  return items;
}

// ── Paging ─────────────────────────────────────────────────────────────────
//
// ★ AN UNBOUNDED READ IS A READ NO CLIENT CAN RECEIVE. `read_inbox` with no arguments returned
// up to 50 notifications with their full bodies, newest first, and nothing that said whether
// there were more. Measured on the relay booted against a fixture inbox of 50 ordinary
// notifications: 88,045 bytes per copy of the result, and every MCP result carries two copies.
// Clients truncated it. A page is now bounded by count, can omit bodies, and states the total
// and where the next page starts, so "the first page" and "the whole inbox" are distinguishable.

/** Notifications returned when the caller names no limit. */
export const INBOX_DEFAULT_LIMIT = 20;
/**
 * The most one page returns. ★ It is 50 because that is the largest limit any caller in this
 * repository passes (`INBOX_LIMIT` / `REQUEST_INBOX_LIMIT` in the workspace client, which infer
 * "saturated" from a page that came back exactly full). A lower ceiling would hand those callers
 * a short page they would read as the whole inbox.
 */
export const INBOX_MAX_LIMIT = 50;

/**
 * Newest first by the INSTANT `published` names, not by its spelling: `2026-01-02T00:00:00+02:00`
 * is earlier than `2026-01-01T23:00:00-01:00`, though it sorts after it as a string, and `since`
 * already compares instants. Then, in order: a `published` that is not a date, newest-first as
 * text; no `published` at all, last. Ties break on the `published` text and then on `url`,
 * descending, so the order is total and a cursor (which carries `published` and `url`, the
 * whole key) names exactly one position.
 *
 * ★ An EMPTY `published` ranks as no `published`. The cursor spells a missing `published` as ''
 * and reads '' back as missing, so the two must sort alike. When '' ranked as a non-date instead,
 * a page ending on such an item resumed among the undated ones, and every non-date item, and
 * every undated one at or after the cursor's url, was never served.
 */
export function compareInboxItems(a: InboxItem, b: InboxItem): number {
  const rank = (item: InboxItem): [number, number] => {
    if (item.published === undefined || item.published === '') return [2, 0];
    const time = Date.parse(item.published);
    return Number.isFinite(time) ? [0, time] : [1, 0];
  };
  const [rankA, timeA] = rank(a);
  const [rankB, timeB] = rank(b);
  if (rankA !== rankB) return rankA - rankB;
  if (timeA !== timeB) return timeB - timeA;
  const byText = (b.published ?? '').localeCompare(a.published ?? '');
  return byText !== 0 ? byText : b.url.localeCompare(a.url);
}

/**
 * An opaque position: the sort key of the last item a page returned. A missing `published` is
 * written as '', which {@link compareInboxItems} ranks exactly as it ranks a missing one.
 */
export function encodeInboxCursor(item: InboxItem): string {
  return Buffer.from(JSON.stringify({ p: item.published ?? '', u: item.url }), 'utf8').toString('base64url');
}

export function decodeInboxCursor(cursor: string): { published: string; url: string } | null {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (!value || typeof value !== 'object') return null;
    const { p, u } = value as Record<string, unknown>;
    if (typeof p !== 'string' || typeof u !== 'string' || !u) return null;
    return { published: p, url: u };
  } catch { return null; }
}

export interface InboxPageOptions {
  /** Items per page; clamped to [1, {@link INBOX_MAX_LIMIT}]. Default {@link INBOX_DEFAULT_LIMIT}. */
  readonly limit?: number;
  /** A `nextCursor` from an earlier page: return only items after it in the order above. */
  readonly before?: string;
  /** ISO-8601: return only items published at or after this instant. Undated items are excluded. */
  readonly since?: string;
  /** false: each item keeps its summary and drops `content`, reporting `contentLength` instead. */
  readonly includeContent?: boolean;
}

export type InboxPageItem = InboxItem & { contentLength?: number };

export interface InboxPage {
  readonly items: InboxPageItem[];
  /** Items matching `since` (the whole inbox when absent), across every page. */
  readonly total: number;
  readonly limit: number;
  readonly hasMore: boolean;
  readonly nextCursor?: string;
}

export class InboxPageError extends Error {}

/**
 * The paging arguments of one `read_inbox` call, read from what a caller sent.
 *
 * They arrive typed on /mcp and as JSON on /tool and /messages, where a REST caller may send a
 * number or a boolean as a string, so both spellings are read. ★ Anything else that is PRESENT
 * is refused with the argument named, never dropped: a dropped `before` or `since` answers with
 * the first, unfiltered page, which reads exactly like a correct answer to the question asked.
 * Absent means undefined, null or the empty string, because clients fill optional fields they
 * were not asked about with those.
 */
export function parseInboxPageArgs(args: Readonly<Record<string, unknown>>):
  { readonly ok: true; readonly options: InboxPageOptions; readonly requestedLimit?: number }
  | { readonly ok: false; readonly error: string } {
  const absent = (v: unknown): boolean => v === undefined || v === null || v === '';
  let requestedLimit: number | undefined;
  if (!absent(args['limit'])) {
    const raw = args['limit'];
    const value = typeof raw === 'number' ? raw
      : typeof raw === 'string' && /^\s*-?\d+\s*$/.test(raw) ? Number(raw) : Number.NaN;
    // A fraction is refused rather than rounded: `limitRequested` is declared an integer, and a
    // page size the caller did not ask for is not one to guess at.
    if (!Number.isInteger(value)) {
      return { ok: false, error: `limit must be a whole number from 1 to ${INBOX_MAX_LIMIT}` };
    }
    requestedLimit = value;
  }
  const flag = args['include_content'];
  const includeContent = absent(flag) ? true
    : flag === false || flag === 'false' ? false
    : flag === true || flag === 'true' ? true : undefined;
  if (includeContent === undefined) return { ok: false, error: 'include_content must be true or false' };
  const text = (name: 'before' | 'since'): string | undefined | null =>
    absent(args[name]) ? undefined : typeof args[name] === 'string' ? args[name] as string : null;
  const before = text('before');
  if (before === null) return { ok: false, error: 'before must be a nextCursor value from an earlier read_inbox page' };
  const since = text('since');
  if (since === null) return { ok: false, error: 'since must be an ISO-8601 date-time' };
  return {
    ok: true,
    options: {
      ...(requestedLimit !== undefined ? { limit: requestedLimit } : {}),
      ...(before !== undefined ? { before } : {}), ...(since !== undefined ? { since } : {}), includeContent,
    },
    ...(requestedLimit !== undefined ? { requestedLimit } : {}),
  };
}

/**
 * One page of an already-read inbox. Pure, so the paging arithmetic is tested without a pod.
 * Throws {@link InboxPageError} for a cursor or `since` it cannot interpret, rather than
 * quietly answering with the first page.
 */
export function pageInboxItems(all: readonly InboxItem[], options: InboxPageOptions = {}): InboxPage {
  const requested = options.limit;
  const limit = typeof requested === 'number' && Number.isFinite(requested)
    ? Math.min(INBOX_MAX_LIMIT, Math.max(1, Math.floor(requested)))
    : INBOX_DEFAULT_LIMIT;
  let matching = [...all].sort(compareInboxItems);
  if (options.since !== undefined) {
    const since = Date.parse(options.since);
    if (!Number.isFinite(since)) throw new InboxPageError('since must be an ISO-8601 date-time');
    matching = matching.filter(item => item.published !== undefined && Date.parse(item.published) >= since);
  }
  let start = 0;
  if (options.before !== undefined) {
    const cursor = decodeInboxCursor(options.before);
    if (!cursor) throw new InboxPageError('before must be a nextCursor value from an earlier read_inbox page');
    const position: InboxItem = { url: cursor.url, ...(cursor.published ? { published: cursor.published } : {}) };
    start = matching.findIndex(item => compareInboxItems(position, item) < 0);
    if (start < 0) start = matching.length;
  }
  const page = matching.slice(start, start + limit);
  const hasMore = start + page.length < matching.length;
  const items: InboxPageItem[] = options.includeContent === false
    ? page.map(({ content, ...rest }) => (content === undefined ? rest : { ...rest, contentLength: content.length }))
    : page;
  return {
    items, total: matching.length, limit, hasMore,
    ...(hasMore && page.length > 0 ? { nextCursor: encodeInboxCursor(page[page.length - 1]!) } : {}),
  };
}
