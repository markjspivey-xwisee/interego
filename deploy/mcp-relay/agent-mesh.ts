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
  { interego: 'https://interego-emergent.example/ns/mcp-relay#' },
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
    ...(input.about ? { 'interego:about': input.about } : {}),
    ...(input.inReplyTo ? { inReplyTo: input.inReplyTo } : {}),
  };
  return {
    '@context': AS2_CONTEXT,
    id: `urn:interego:notif:${idSlug}`,
    type: input.type ?? 'Create',
    actor: input.from,
    to: [input.to],
    published: input.published,
    summary: input.summary,
    object: obj,
  };
}

/**
 * Deliver a notification into a target pod's LDN inbox. The relay's
 * fetch (service creds) writes the file; CSS auto-creates the `inbox/`
 * container on first PUT. Returns the notification URL, or null on
 * failure (best-effort — delivery failures never fail the caller).
 */
export async function deliverNotification(
  targetPodUrl: string,
  notif: Record<string, unknown>,
  idSlug: string,
  fetchFn: FetchFn = defaultFetch(),
  log: (m: string) => void = () => {},
): Promise<string | null> {
  const url = `${inboxUrlFor(targetPodUrl)}${idSlug}.jsonld`;
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

/**
 * Read + parse a pod's inbox, newest-first. Best-effort: unreadable
 * items are skipped. `limit` caps how many are returned.
 */
export async function readInbox(
  podUrl: string,
  fetchFn: FetchFn = defaultFetch(),
  limit = 50,
): Promise<InboxItem[]> {
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
      if (!d || typeof d !== 'object') return;
      const obj = (d.object ?? {}) as Record<string, any>;
      items.push({
        url,
        id: d.id,
        type: d.type,
        actor: d.actor,
        summary: d.summary ?? obj.summary,
        content: obj.content ?? d.content,
        about: obj['interego:about'] ?? obj['https://interego-emergent.example/ns/mcp-relay#about'] ?? d['interego:about'] ?? d.about,
        published: d.published,
      });
    } catch { /* skip */ }
  }));
  items.sort((a, b) => (b.published ?? '').localeCompare(a.published ?? ''));
  return items.slice(0, limit);
}
