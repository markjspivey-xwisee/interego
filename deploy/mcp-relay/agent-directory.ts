/**
 * Shared agent directory.
 *
 * An agent card is a public context descriptor the agent publishes on its own
 * namespace (`/ns/<agentId>/agent-card`) through the relay's existing
 * `publish_context` path, signed with the same authorship proof every other
 * public document uses. This module does not keep a second registry of who
 * an agent is. It stores a cache of the public projection so search does not
 * crawl every pod, and the signed document at the card IRI remains the record.
 *
 * The authenticated session chooses the subject. A caller can replace only
 * the card whose agent id is that session. Contact addresses are minted by
 * the relay (the same `/agents/<id>` address `notify_agent` already resolves);
 * a caller-supplied inbox or pod URL is ignored. Requesting work looks the
 * card up and hands the message to `notify_agent`, which writes the
 * recipient's LDN inbox.
 *
 * Nothing in the cache, the HTTP responses, or the published graph is a
 * credential. Text is screened before publish, and the projection is an
 * allowlist: name, description, capabilities, and the public contact IRIs.
 */
import { createHash } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import { escapeTurtleLiteral, turtleIriRef } from '@interego/core';
import { screenForSensitiveContent, type SensitivityFlag } from '@interego/privacy';

const IEP = 'https://markjspivey-xwisee.github.io/interego/ns/iep#';
const AGENT_ID = /^(?:u-pk-|u-did-|u-eth-|eth-)[0-9a-z]+$/;
/** The directory does not evict. Replacing your card does not take a new slot; withdrawing frees one. */
export const DIRECTORY_CARD_CAP = 500;
const MAX_CARDS = DIRECTORY_CARD_CAP;
const MAX_CAPABILITIES = 24;
const SEARCH_LIMIT = 50;

export interface AgentCapability {
  readonly id: string;
  readonly name: string;
  readonly description: string;
}

/** The public projection of one card. Every field here is safe to show. */
export interface PublicAgentCard {
  readonly agentId: string;
  readonly name: string;
  readonly description: string;
  readonly cardIri: string;
  readonly relayAddress: string;
  readonly version: string;
  readonly updatedAt: string;
  readonly capabilities: readonly AgentCapability[];
  readonly inbox?: string;
  readonly did?: string;
  readonly surface?: string;
  readonly descriptorUrl?: string;
}

export interface DirectoryCaller {
  readonly agentId: string;
  readonly did?: string;
}

export interface DirectoryFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}

export type DirectoryFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<DirectoryFetchResponse>;

/**
 * One card, one file. A whole-directory rewrite drops whatever another
 * relay instance published between the read and the write.
 */
export interface DirectoryStore {
  load(): Promise<PublicAgentCard[]>;
  put(card: PublicAgentCard): Promise<void>;
  remove(agentId: string): Promise<void>;
}

export interface AgentDirectoryDeps {
  /** Relay origin, no trailing slash. Card IRIs are minted under `<base>/ns/`. */
  readonly publicBaseUrl: string;
  /** `POST` target of the existing notify_agent tool. */
  readonly notifyTarget: string;
  callerOf(args: Record<string, unknown>): DirectoryCaller | null;
  /** The relay's own address minter. Inbox may be internal; it is dropped if so. */
  contactFor(agentId: string): { relayAddress: string; inbox?: string };
  publish(args: Record<string, unknown>): Promise<string>;
  notify(args: Record<string, unknown>): Promise<string>;
  readonly store?: DirectoryStore;
  readonly log?: (msg: string) => void;
  now?: () => string;
}

interface CardDraft {
  readonly name: string;
  readonly description: string;
  readonly surface?: string;
  readonly capabilities: readonly { name: string; description: string; id?: string }[];
}

export interface AgentDirectory {
  publishCard(args: Record<string, unknown>): Promise<string>;
  searchAgents(args: Record<string, unknown>): Promise<string>;
  getAgentCard(args: Record<string, unknown>): Promise<string>;
  requestWork(args: Record<string, unknown>): Promise<string>;
  hydrate(): Promise<void>;
  withdrawCard(args: Record<string, unknown>): Promise<string>;
  /** Drop directory cards for a pod whose agent was just revoked. */
  forgetRevoked(podName: string, subjects: readonly string[]): Promise<readonly string[]>;
  mount(app: Express): void;
  /** In-process snapshot. Tests and the HTML renderer read this; it is not a second source of truth. */
  list(): readonly PublicAgentCard[];
}

function json(body: unknown): string {
  return JSON.stringify(body);
}

function sessionFields(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (key.startsWith('_session_')) out[key] = value;
  }
  return out;
}

/**
 * A URL we are willing to print on a public card.
 * Embedded credentials and cluster-internal hosts are never printed.
 * Loopback hosts are printed only when this relay itself is loopback, so a
 * local process can address itself and a public relay cannot advertise one.
 */
export function publicHttpUrl(value: string, allowLocal = false): string | undefined {
  let url: URL;
  try { url = new URL(value); } catch { return undefined; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  if (url.username || url.password) return undefined;
  const host = url.hostname.toLowerCase();
  const local = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if ((local && !allowLocal) || host.endsWith('.internal') || host.endsWith('.local')) return undefined;
  if (turtleIriRef(value) === null) return undefined;
  return value;
}

function baseAllowsLocal(base: string): boolean {
  try {
    const host = new URL(base).hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch { return false; }
}

function httpsCapabilityUrl(value: string): string | undefined {
  const printed = publicHttpUrl(value);
  if (!printed || !printed.startsWith('https:')) return undefined;
  return printed;
}

function slug(name: string, used: Set<string>): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'capability';
  let next = base;
  let n = 2;
  while (used.has(next)) next = `${base}-${n++}`;
  used.add(next);
  return next;
}

function cardVersion(card: Omit<PublicAgentCard, 'version' | 'updatedAt' | 'descriptorUrl'>): string {
  const canonical = JSON.stringify({
    agentId: card.agentId,
    name: card.name,
    description: card.description,
    relayAddress: card.relayAddress,
    inbox: card.inbox ?? null,
    did: card.did ?? null,
    surface: card.surface ?? null,
    capabilities: card.capabilities.map(c => ({ id: c.id, name: c.name, description: c.description })),
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

/** Turtle for the public graph. Returns null when a required IRI cannot be written safely. */
export function cardTurtle(card: PublicAgentCard): string | null {
  const subject = turtleIriRef(card.cardIri);
  const iepNs = turtleIriRef(IEP);
  const endpoint = escapeTurtleLiteral(card.relayAddress);
  if (!subject || !iepNs || publicHttpUrl(card.relayAddress) === undefined) return null;
  const lines = [
    '@prefix iep: ' + iepNs + ' .',
    '@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .',
    '@prefix ldp: <http://www.w3.org/ns/ldp#> .',
    '@prefix prov: <http://www.w3.org/ns/prov#> .',
    '',
  ];
  const triples = [
    `${subject} a iep:Agent`,
    `rdfs:label "${escapeTurtleLiteral(card.name)}"`,
    `rdfs:comment "${escapeTurtleLiteral(card.description)}"`,
    `iep:serviceEndpoint "${endpoint}"`,
    `iep:cardVersion "${escapeTurtleLiteral(card.version)}"`,
  ];
  if (card.inbox) {
    const inbox = turtleIriRef(card.inbox);
    if (!inbox) return null;
    triples.push(`ldp:inbox ${inbox}`);
  }
  if (card.did) {
    const did = turtleIriRef(card.did);
    if (!did) return null;
    triples.push(`prov:wasAttributedTo ${did}`);
  }
  const offerRefs: string[] = [];
  const blocks: string[] = [];
  for (const cap of card.capabilities) {
    const node = turtleIriRef(cap.id);
    const action = turtleIriRef(cap.id);
    if (!node || !action) return null;
    offerRefs.push(node);
    const capTriples = [
      `${node} a iep:Affordance`,
      `iep:action ${action}`,
      `rdfs:label "${escapeTurtleLiteral(cap.name)}"`,
    ];
    if (cap.description) capTriples.push(`rdfs:comment "${escapeTurtleLiteral(cap.description)}"`);
    blocks.push(`${capTriples.join(' ;\n    ')} .`);
  }
  if (offerRefs.length > 0) triples.push(`iep:offers ${offerRefs.join(' , ')}`);
  lines.push(`${triples.join(' ;\n    ')} .`);
  lines.push(...blocks);
  return `${lines.join('\n')}\n`;
}

function screenedText(parts: readonly string[]): SensitivityFlag | 'credential' | null {
  const text = parts.join('\n');
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/i.test(text) || /\bBearer\s+[A-Za-z0-9._\-]{8,}/.test(text)) {
    return 'credential';
  }
  const flags = screenForSensitiveContent(text).filter(f => f.severity === 'high' || f.severity === 'medium');
  return flags[0] ?? null;
}

function parseDraft(args: Record<string, unknown>): CardDraft | { error: string; code: number; message: string } {
  const name = typeof args['name'] === 'string' ? args['name'].trim() : '';
  const description = typeof args['description'] === 'string' ? args['description'].trim() : '';
  if (name.length < 1 || name.length > 80) {
    return { error: 'invalid_card', code: 400, message: 'name must be 1–80 characters.' };
  }
  if (description.length < 1 || description.length > 600) {
    return { error: 'invalid_card', code: 400, message: 'description must be 1–600 characters.' };
  }
  let surface: string | undefined;
  if (args['surface'] !== undefined && args['surface'] !== '') {
    if (typeof args['surface'] !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/.test(args['surface'])) {
      return { error: 'invalid_card', code: 400, message: 'surface must be a short label (letters, digits, space, . _ -).' };
    }
    surface = args['surface'];
  }
  const rawCaps = args['capabilities'];
  if (rawCaps !== undefined && !Array.isArray(rawCaps)) {
    return { error: 'invalid_card', code: 400, message: 'capabilities must be a list.' };
  }
  const list = Array.isArray(rawCaps) ? rawCaps : [];
  if (list.length > MAX_CAPABILITIES) {
    return { error: 'invalid_card', code: 400, message: `A card lists at most ${MAX_CAPABILITIES} capabilities.` };
  }
  const capabilities: { name: string; description: string; id?: string }[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { error: 'invalid_card', code: 400, message: 'Each capability needs a name.' };
    }
    const rec = item as Record<string, unknown>;
    const capName = typeof rec['name'] === 'string' ? rec['name'].trim() : '';
    const capDescription = typeof rec['description'] === 'string' ? rec['description'].trim() : '';
    if (capName.length < 1 || capName.length > 80) {
      return { error: 'invalid_card', code: 400, message: 'Each capability name must be 1–80 characters.' };
    }
    if (capDescription.length > 300) {
      return { error: 'invalid_card', code: 400, message: 'Each capability description must be at most 300 characters.' };
    }
    let id: string | undefined;
    if (rec['id'] !== undefined && rec['id'] !== '') {
      if (typeof rec['id'] !== 'string' || httpsCapabilityUrl(rec['id'].trim()) === undefined) {
        return { error: 'invalid_card', code: 400, message: 'A capability id must be an https URL with no embedded secret.' };
      }
      id = rec['id'].trim();
    }
    capabilities.push({ name: capName, description: capDescription, ...(id ? { id } : {}) });
  }
  return { name, description, ...(surface ? { surface } : {}), capabilities };
}

function assignCapabilityIds(cardIri: string, draft: CardDraft): AgentCapability[] | null {
  const used = new Set<string>();
  const out: AgentCapability[] = [];
  for (const cap of draft.capabilities) {
    const id = cap.id ?? `${cardIri}#${slug(cap.name, used)}`;
    // Caller-supplied ids are https with no secret. An id this function mints is a
    // fragment of the card document, which is http only when the relay itself is.
    const minted = id.startsWith(`${cardIri}#`);
    if (minted ? turtleIriRef(id) === null : httpsCapabilityUrl(id) === undefined) return null;
    if (out.some(existing => existing.id === id)) return null;
    out.push({ id, name: cap.name, description: cap.description });
  }
  return out;
}

function matches(card: PublicAgentCard, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  const hay = [
    card.name, card.description, card.agentId, card.surface ?? '', card.did ?? '',
    ...card.capabilities.flatMap(c => [c.name, c.description, c.id]),
  ].join('\n').toLowerCase();
  return hay.includes(needle);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function wireCard(card: PublicAgentCard, notifyTarget: string, base: string): Record<string, unknown> {
  return {
    '@id': card.cardIri,
    '@type': 'iep:Agent',
    agentId: card.agentId,
    name: card.name,
    description: card.description,
    cardIri: card.cardIri,
    serviceEndpoint: card.relayAddress,
    relayAddress: card.relayAddress,
    version: card.version,
    updatedAt: card.updatedAt,
    ...(card.inbox ? { inbox: card.inbox } : {}),
    ...(card.did ? { did: card.did } : {}),
    ...(card.surface ? { surface: card.surface } : {}),
    ...(card.descriptorUrl ? { descriptorUrl: card.descriptorUrl } : {}),
    capabilities: card.capabilities.map(c => ({ id: c.id, name: c.name, description: c.description })),
    affordances: [{
      '@type': ['iep:Affordance', 'hydra:Operation'],
      title: 'notify_agent',
      description: `Send work to ${card.name}. POST these arguments to the target with your own summary and content. The relay delivers them to this agent's LDN inbox.`,
      method: 'POST',
      target: notifyTarget,
      arguments: { to: card.relayAddress },
    }],
    // The well-known documents describe this relay, not this agent. Extra
    // channels stay on the federation row via set_reachability.
    seeAlso: [
      `${base}/.well-known/agent-card.json`,
      `${base}/.well-known/interego-agents.json`,
    ],
    reachability: 'This card is the agent\'s signed self-description and its LDN address. /.well-known/agent-card.json describes the relay. Channels other than the inbox are set_reachability on the federation row that list_known_pods already lists.',
  };
}

function page(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light; --ink: #1c1915; --muted: #5c564c; --line: #e4ddd2; --paper: #f7f3ec; --card: #fffdf8; --accent: #0f6e56; }
  body { margin: 0; font: 16px/1.5 Georgia, "Iowan Old Style", Palatino, serif; color: var(--ink); background: var(--paper); }
  header, main { max-width: 46rem; margin: 0 auto; padding: 1.25rem 1.25rem 0; }
  h1 { font-size: 1.8rem; line-height: 1.2; margin: 0 0 .4rem; }
  h2 { font-size: 1.25rem; margin: 0; }
  p, li { color: var(--ink); }
  .lede, .meta, footer { color: var(--muted); }
  form { display: flex; gap: .5rem; margin: 1rem 0 1.5rem; }
  input[type=search] { flex: 1; font: inherit; padding: .45rem .6rem; border: 1px solid var(--line); background: var(--card); }
  button, .chip { font: 14px/1 ui-sans-serif, system-ui, sans-serif; }
  button { background: var(--accent); color: white; border: 0; padding: .5rem .8rem; cursor: pointer; }
  article { background: var(--card); border: 1px solid var(--line); padding: 1rem 1.1rem; margin: 0 0 .8rem; }
  a { color: var(--accent); }
  .chips { display: flex; flex-wrap: wrap; gap: .35rem; margin: .6rem 0 0; padding: 0; list-style: none; }
  .chip { border: 1px solid var(--line); padding: .15rem .45rem; text-decoration: none; color: var(--ink); }
  pre { white-space: pre-wrap; background: #f0ebe3; padding: .8rem; font: 13px/1.45 ui-monospace, monospace; }
  footer { padding: 1.5rem 1.25rem 2rem; max-width: 46rem; margin: 0 auto; font-size: .9rem; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

function searchForm(q: string): string {
  return `<form method="get" action="/directory" role="search">
<label for="q" class="meta">Search by name or capability</label>
<input id="q" name="q" type="search" value="${escapeHtml(q)}" placeholder="summarize, review, georgio">
<button type="submit">Search</button>
</form>`;
}

function cardArticle(card: PublicAgentCard): string {
  const chips = card.capabilities.map(c =>
    `<li><a class="chip" href="/directory?q=${encodeURIComponent(c.name)}">${escapeHtml(c.name)}</a></li>`,
  ).join('');
  return `<article>
<h2><a href="/directory/agent/${encodeURIComponent(card.agentId)}">${escapeHtml(card.name)}</a></h2>
<p>${escapeHtml(card.description)}</p>
<p class="meta">${escapeHtml(card.agentId)}${card.surface ? ` · ${escapeHtml(card.surface)}` : ''}</p>
${chips ? `<ul class="chips">${chips}</ul>` : ''}
</article>`;
}

function directoryHtml(cards: readonly PublicAgentCard[], q: string): string {
  const shown = cards.filter(c => matches(c, q)).slice(0, SEARCH_LIMIT);
  const list = shown.length
    ? shown.map(cardArticle).join('\n')
    : `<p>No published cards match${q ? ` “${escapeHtml(q)}”` : ''}.</p>`;
  return page('Interego agent directory', `<header>
<h1>Agent directory</h1>
<p class="lede">Agents who have published a signed card on their own Interego namespace. The card says who they are, what they can do, and how to reach their inbox.</p>
${searchForm(q)}
</header>
<main>${list}</main>
<footer>This page reads the directory cache. The signed document for an agent is the public graph at their card IRI. Sending work is an authenticated call to <code>notify_agent</code>, which delivers into that agent's LDN inbox.</footer>`);
}

function agentHtml(card: PublicAgentCard, notifyTarget: string): string {
  const caps = card.capabilities.length
    ? `<ul>${card.capabilities.map(c => `<li><strong>${escapeHtml(c.name)}</strong>${c.description ? ` — ${escapeHtml(c.description)}` : ''}<br><span class="meta">${escapeHtml(c.id)}</span></li>`).join('')}</ul>`
    : '<p class="meta">No capabilities listed.</p>';
  const inbox = card.inbox ? `<li>LDN inbox: <a href="${escapeHtml(card.inbox)}">${escapeHtml(card.inbox)}</a></li>` : '';
  const sample = JSON.stringify({ to: card.relayAddress, summary: 'Work for you', content: 'Describe the work here.' }, null, 2);
  return page(card.name, `<header>
<p class="meta"><a href="/directory">Directory</a></p>
<h1>${escapeHtml(card.name)}</h1>
<p>${escapeHtml(card.description)}</p>
<p class="meta">${escapeHtml(card.agentId)}${card.surface ? ` · ${escapeHtml(card.surface)}` : ''}${card.did ? ` · ${escapeHtml(card.did)}` : ''}</p>
</header>
<main>
<h2>Capabilities</h2>
${caps}
<h2>How to reach this agent</h2>
<ul>
<li>Relay address: <a href="${escapeHtml(card.relayAddress)}">${escapeHtml(card.relayAddress)}</a></li>
${inbox}
<li>Signed card: <a href="${escapeHtml(card.cardIri)}">${escapeHtml(card.cardIri)}</a></li>
</ul>
<p>Sending work is a signed-in call. It routes through <code>notify_agent</code> into this agent's inbox. This page does not send anything.</p>
<p class="meta">This card is the agent's signed self-description. <code>/.well-known/agent-card.json</code> describes the relay, not this agent. Channels other than the inbox are <code>set_reachability</code> on the federation row.</p>
<pre>POST ${escapeHtml(notifyTarget)}
Authorization: Bearer &lt;your Interego token&gt;
Content-Type: application/json

${escapeHtml(sample)}</pre>
</main>`);
}

function readPublishReceipt(raw: string): { ok: true; descriptorUrl?: string } | { ok: false; body: Record<string, unknown> } {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch {
    return { ok: false, body: { error: 'publish_failed', code: 502, message: 'The card publish did not return a readable result. Nothing was indexed.' } };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, body: { error: 'publish_failed', code: 502, message: 'The card publish did not return a readable result. Nothing was indexed.' } };
  }
  const rec = parsed as Record<string, unknown>;
  if (rec['error'] || rec['published'] !== true || rec['status'] === 'pending') {
    const message = typeof rec['message'] === 'string' ? rec['message'] : 'The card was not committed, so it was not indexed.';
    return {
      ok: false,
      body: {
        error: typeof rec['error'] === 'string' ? rec['error'] : 'publish_not_committed',
        code: typeof rec['code'] === 'number' ? rec['code'] : 502,
        message,
        ...(Array.isArray(rec['violations']) ? { violations: rec['violations'] } : {}),
      },
    };
  }
  const descriptorUrl = typeof rec['descriptorUrl'] === 'string' ? publicHttpUrl(rec['descriptorUrl']) : undefined;
  return { ok: true, ...(descriptorUrl ? { descriptorUrl } : {}) };
}

/** cardIri and relayAddress are functions of the agent id. A stored row that names different ones is dropped. */
export function cardAddresses(agentId: string, base: string, relayAddress: string): { cardIri: string; relayAddress: string } {
  return { cardIri: `${base.replace(/\/$/, '')}/ns/${agentId}/agent-card`, relayAddress };
}

function asStoredCard(
  value: unknown,
  expected?: { cardIri: string; relayAddress: string },
): PublicAgentCard | null {
  if (!value || typeof value !== 'object') return null;
  const rec = value as Record<string, unknown>;
  const agentId = typeof rec['agentId'] === 'string' ? rec['agentId'] : '';
  const name = typeof rec['name'] === 'string' ? rec['name'] : '';
  const description = typeof rec['description'] === 'string' ? rec['description'] : '';
  const cardIri = typeof rec['cardIri'] === 'string' ? rec['cardIri'] : '';
  const relayAddress = typeof rec['relayAddress'] === 'string' ? rec['relayAddress'] : '';
  const version = typeof rec['version'] === 'string' ? rec['version'] : '';
  const updatedAt = typeof rec['updatedAt'] === 'string' ? rec['updatedAt'] : '';
  if (!AGENT_ID.test(agentId) || !name || !description || !version || !updatedAt) return null;
  if (!expected) return null;
  if (cardIri !== expected.cardIri || relayAddress !== expected.relayAddress) return null;
  if (publicHttpUrl(expected.cardIri) === undefined || publicHttpUrl(expected.relayAddress) === undefined) return null;
  if (!Array.isArray(rec['capabilities'])) return null;
  const capabilities: AgentCapability[] = [];
  for (const item of rec['capabilities']) {
    if (!item || typeof item !== 'object') return null;
    const cap = item as Record<string, unknown>;
    const id = typeof cap['id'] === 'string' ? cap['id'] : '';
    const capName = typeof cap['name'] === 'string' ? cap['name'] : '';
    const capDescription = typeof cap['description'] === 'string' ? cap['description'] : '';
    if (httpsCapabilityUrl(id) === undefined || !capName) return null;
    capabilities.push({ id, name: capName, description: capDescription });
  }
  const inbox = typeof rec['inbox'] === 'string' ? publicHttpUrl(rec['inbox']) : undefined;
  const did = typeof rec['did'] === 'string' && turtleIriRef(rec['did']) ? rec['did'] : undefined;
  const surface = typeof rec['surface'] === 'string' && /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/.test(rec['surface']) ? rec['surface'] : undefined;
  const descriptorUrl = typeof rec['descriptorUrl'] === 'string' ? publicHttpUrl(rec['descriptorUrl']) : undefined;
  const card: PublicAgentCard = {
    agentId, name, description, cardIri: expected.cardIri, relayAddress: expected.relayAddress, version, updatedAt, capabilities,
    ...(inbox ? { inbox } : {}),
    ...(did ? { did } : {}),
    ...(surface ? { surface } : {}),
    ...(descriptorUrl ? { descriptorUrl } : {}),
  };
  const secret = screenedText([
    name, description, surface ?? '', did ?? '',
    ...capabilities.flatMap(c => [c.name, c.description, c.id]),
  ]);
  if (secret) return null;
  return card;
}

export function parseStoredCards(
  body: unknown,
  addressFor: (agentId: string) => { cardIri: string; relayAddress: string },
): PublicAgentCard[] {
  const list = Array.isArray(body)
    ? body
    : (body && typeof body === 'object' && Array.isArray((body as { cards?: unknown }).cards)
      ? (body as { cards: unknown[] }).cards
      : []);
  const out: PublicAgentCard[] = [];
  for (const item of list) {
    const agentId = item && typeof item === 'object' && typeof (item as { agentId?: unknown }).agentId === 'string'
      ? (item as { agentId: string }).agentId : '';
    const card = asStoredCard(item, AGENT_ID.test(agentId) ? addressFor(agentId) : undefined);
    if (card && !out.some(existing => existing.agentId === card.agentId)) out.push(card);
  }
  return out;
}

export function podDirectoryStore(cfg: {
  podUrl: string;
  fetch: DirectoryFetch;
  log?: (msg: string) => void;
  /** Recompute cardIri and relayAddress. A stored row that disagrees is dropped. */
  addressFor: (agentId: string) => { cardIri: string; relayAddress: string };
}): DirectoryStore {
  const container = `${cfg.podUrl.replace(/\/$/, '')}/agent-directory/`;
  const legacy = `${container}index.jsonld`;
  const fileFor = (agentId: string): string => `${container}${agentId}.jsonld`;
  const log = cfg.log ?? (() => {});

  async function readCard(url: string): Promise<PublicAgentCard | null> {
    const res = await cfg.fetch(url, { method: 'GET', headers: { Accept: 'application/ld+json' } });
    if (!res.ok) return null;
    try {
      const parsed = JSON.parse(await res.text()) as unknown;
      const one = parsed && typeof parsed === 'object' && !Array.isArray(parsed) && !('cards' in (parsed as object))
        ? [parsed]
        : parsed;
      return parseStoredCards(one, cfg.addressFor)[0] ?? null;
    } catch { return null; }
  }

  return {
    async load() {
      const listing = await cfg.fetch(container, { method: 'GET', headers: { Accept: 'text/turtle' } });
      const urls = new Set<string>();
      if (listing.ok) {
        const body = await listing.text();
        for (const match of body.matchAll(/<([^>\s]+\.jsonld)>/g)) {
          try { urls.add(new URL(match[1]!, container).toString()); } catch { /* skip */ }
        }
      }
      const perCard = [...urls].filter(url => url !== legacy);
      const loaded: PublicAgentCard[] = [];
      const have = new Set<string>();
      for (const url of perCard) {
        const card = await readCard(url);
        if (card && !have.has(card.agentId)) { loaded.push(card); have.add(card.agentId); }
      }
      // A per-card file does not mean the legacy index is finished. A PUT that
      // failed last time left the rest of the index behind, and deleting it
      // then would drop those cards on the next boot.
      const res = await cfg.fetch(legacy, { method: 'GET', headers: { Accept: 'application/ld+json' } });
      if (!res.ok) return loaded;
      let fromLegacy: PublicAgentCard[] = [];
      try { fromLegacy = parseStoredCards(JSON.parse(await res.text()), cfg.addressFor); }
      catch { return loaded; }
      let migratedAll = true;
      for (const card of fromLegacy) {
        if (have.has(card.agentId)) continue;
        const put = await cfg.fetch(fileFor(card.agentId), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/ld+json' },
          body: JSON.stringify(card),
        });
        if (!put.ok) {
          migratedAll = false;
          log(`[agent-directory] migrate ${card.agentId} failed: ${put.status}`);
          continue;
        }
        loaded.push(card);
        have.add(card.agentId);
      }
      if (migratedAll) await cfg.fetch(legacy, { method: 'DELETE' });
      return loaded;
    },
    async put(card) {
      const res = await cfg.fetch(fileFor(card.agentId), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/ld+json' },
        body: JSON.stringify(card),
      });
      if (!res.ok) throw new Error(`agent directory card PUT failed: ${res.status}`);
    },
    async remove(agentId) {
      if (!AGENT_ID.test(agentId)) return;
      const res = await cfg.fetch(fileFor(agentId), { method: 'DELETE' });
      if (!res.ok && res.status !== 404) throw new Error(`agent directory card DELETE failed: ${res.status}`);
    },
  };
}

export function createAgentDirectory(deps: AgentDirectoryDeps): AgentDirectory {
  const cards = new Map<string, PublicAgentCard>();
  /** New agents whose publish has reserved a slot and not finished. Counted toward the cap. */
  const reserved = new Set<string>();
  const agentChain = new Map<string, Promise<void>>();
  const base = deps.publicBaseUrl.replace(/\/$/, '');
  let tail: Promise<void> = Promise.resolve();
  const now = deps.now ?? (() => new Date().toISOString());

  function exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = tail.then(fn, fn);
    tail = run.then(() => undefined, () => undefined);
    return run;
  }

  /** One agent at a time, so a failed later attempt cannot discard an earlier success, and a revocation waits for the publish it must undo. Other agents are not in this chain. */
  function onAgent<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
    const previous = agentChain.get(agentId) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    agentChain.set(agentId, run.then(() => undefined, () => undefined));
    return run;
  }

  function snapshot(q = '', limit = SEARCH_LIMIT): PublicAgentCard[] {
    return [...cards.values()].filter(card => matches(card, q)).slice(0, limit);
  }

  function addressFor(agentId: string): { cardIri: string; relayAddress: string } | null {
    const contact = deps.contactFor(agentId);
    const allowLocal = baseAllowsLocal(base);
    const relayAddress = publicHttpUrl(contact.relayAddress, allowLocal);
    if (!relayAddress) return null;
    return cardAddresses(agentId, base, relayAddress);
  }

  function prepareCard(args: Record<string, unknown>):
    | { error: string; code: number; message: string }
    | { caller: DirectoryCaller; card: PublicAgentCard; turtle: string } {
    const caller = deps.callerOf(args);
    if (!caller || !AGENT_ID.test(caller.agentId)) {
      return { error: 'authentication_required', code: 401, message: 'Sign in as the agent whose card this is. The directory will not guess an id.' };
    }
    // agent_id is the actor the relay injects (a DID or IRI), not the card subject.
    const claimed = typeof args['agent_id'] === 'string' ? args['agent_id'].trim() : '';
    if (claimed && claimed !== caller.agentId && claimed !== caller.did) {
      return { error: 'not_your_card', code: 403, message: 'An agent may only publish or replace its own card.' };
    }
    if (args['pod_name'] !== undefined && args['pod_name'] !== caller.agentId) {
      return { error: 'not_your_card', code: 403, message: 'An agent may only publish its card on its own pod.' };
    }
    const draft = parseDraft(args);
    if ('error' in draft) return draft;
    const secret = screenedText([
      draft.name, draft.description, draft.surface ?? '',
      ...draft.capabilities.flatMap(c => [c.name, c.description, c.id ?? '']),
    ]);
    if (secret) {
      const message = secret === 'credential'
        ? 'Refusing to publish: the card contains a credential or private key.'
        : `Refusing to publish: ${secret.description}.`;
      return { error: 'secret_refused', code: 400, message };
    }
    const located = addressFor(caller.agentId);
    if (!located) {
      return { error: 'contact_unavailable', code: 500, message: 'This relay has no public address for that agent, so the card was not published.' };
    }
    const inboxRaw = deps.contactFor(caller.agentId).inbox;
    const inbox = inboxRaw ? publicHttpUrl(inboxRaw, baseAllowsLocal(base)) : undefined;
    const did = caller.did && turtleIriRef(caller.did) ? caller.did : undefined;
    const capabilities = assignCapabilityIds(located.cardIri, draft);
    if (!capabilities) return { error: 'invalid_card', code: 400, message: 'A capability id must be a unique https URL.' };
    const unsigned = {
      agentId: caller.agentId,
      name: draft.name,
      description: draft.description,
      cardIri: located.cardIri,
      relayAddress: located.relayAddress,
      capabilities,
      ...(inbox ? { inbox } : {}),
      ...(did ? { did } : {}),
      ...(draft.surface ? { surface: draft.surface } : {}),
    };
    const card: PublicAgentCard = { ...unsigned, version: cardVersion(unsigned), updatedAt: now() };
    const turtle = cardTurtle(card);
    if (!turtle) return { error: 'invalid_card', code: 400, message: 'The card could not be written as a public graph.' };
    return { caller, card, turtle };
  }

  return {
    list: () => [...cards.values()],

    async hydrate() {
      if (!deps.store) return;
      try {
        await exclusive(async () => {
          const loaded = await deps.store!.load();
          for (const card of loaded) {
            if (!cards.has(card.agentId)) cards.set(card.agentId, card);
          }
        });
      } catch (err) {
        deps.log?.(`[agent-directory] hydrate failed: ${(err as Error).message}`);
      }
    },

    async publishCard(args) {
      const prepared = prepareCard(args);
      if ('error' in prepared) return json(prepared);
      const { caller, card, turtle } = prepared;
      return onAgent(caller.agentId, async () => {
        const gate = await exclusive(async () => {
          if (cards.has(caller.agentId) || reserved.has(caller.agentId)) return 'replace' as const;
          if (cards.size + reserved.size >= MAX_CARDS) return 'full' as const;
          reserved.add(caller.agentId);
          return 'new' as const;
        });
        if (gate === 'full') {
          return json({
            error: 'directory_full',
            code: 503,
            message: `The directory holds ${MAX_CARDS} cards and does not evict one to make room. Replacing your own card still works. Withdraw a card to free a slot.`,
          });
        }
        let indexed = false;
        try {
          const published = await deps.publish({
            ...sessionFields(args),
            pod_name: caller.agentId,
            graph_iri: card.cardIri,
            graph_content: turtle,
            visibility: 'public',
            sign_authorship: true,
            sync: true,
            descriptor_id: `urn:iep:agent-card:${caller.agentId}`,
            auto_supersede_prior: true,
            modal_status: 'Asserted',
          });
          const receipt = readPublishReceipt(published);
          if (receipt.ok === false) return json(receipt.body);
          return exclusive(async () => {
            reserved.delete(caller.agentId);
            const stored: PublicAgentCard = { ...card, ...(receipt.descriptorUrl ? { descriptorUrl: receipt.descriptorUrl } : {}) };
            cards.set(caller.agentId, stored);
            indexed = true;
            let persisted = false;
            try {
              if (deps.store) { await deps.store.put(stored); persisted = true; }
            } catch (err) { deps.log?.(`[agent-directory] index persist failed: ${(err as Error).message}`); }
            return json({ published: true, persisted, ...wireCard(stored, deps.notifyTarget, base) });
          });
        } finally {
          if (!indexed) await exclusive(async () => { reserved.delete(caller.agentId); });
        }
      });
    },

    async withdrawCard(args) {
      const caller = deps.callerOf(args);
      if (!caller || !AGENT_ID.test(caller.agentId)) {
        return json({ error: 'authentication_required', code: 401, message: 'Sign in as the agent whose card this is.' });
      }
      const claimed = typeof args['agent_id'] === 'string' ? args['agent_id'].trim() : '';
      if (claimed && claimed !== caller.agentId && claimed !== caller.did) {
        return json({ error: 'not_your_card', code: 403, message: 'An agent may only withdraw its own card.' });
      }
      const existing = cards.get(caller.agentId);
      if (!existing) return json({ error: 'no_such_agent', code: 404, message: 'You have no directory card to withdraw.' });
      const located = addressFor(caller.agentId);
      if (!located) return json({ error: 'contact_unavailable', code: 500, message: 'This relay has no public address for that agent, so the card was not withdrawn.' });
      const withdrawn: PublicAgentCard = {
        ...existing,
        description: 'Withdrawn from the agent directory.',
        capabilities: [],
        cardIri: located.cardIri,
        relayAddress: located.relayAddress,
        updatedAt: now(),
      };
      const turtle = cardTurtle({ ...withdrawn, version: cardVersion(withdrawn) });
      if (!turtle) return json({ error: 'invalid_card', code: 400, message: 'The withdrawal could not be written as a public graph.' });
      return onAgent(caller.agentId, async () => {
        const published = await deps.publish({
          ...sessionFields(args),
          pod_name: caller.agentId,
          graph_iri: located.cardIri,
          graph_content: turtle,
          visibility: 'public',
          sign_authorship: true,
          sync: true,
          descriptor_id: `urn:iep:agent-card:${caller.agentId}`,
          auto_supersede_prior: true,
          modal_status: 'Counterfactual',
        });
        const receipt = readPublishReceipt(published);
        if (receipt.ok === false) return json(receipt.body);
        return exclusive(async () => {
          cards.delete(caller.agentId);
          reserved.delete(caller.agentId);
          try { if (deps.store) await deps.store.remove(caller.agentId); }
          catch (err) { deps.log?.(`[agent-directory] index remove failed: ${(err as Error).message}`); }
          return json({ withdrawn: true, agentId: caller.agentId, cardIri: located.cardIri });
        });
      });
    },

    async forgetRevoked(podName, subjects) {
      const targets = new Set<string>();
      if (AGENT_ID.test(podName)) targets.add(podName);
      for (const subject of subjects) if (AGENT_ID.test(subject)) targets.add(subject);
      await exclusive(async () => {
        for (const card of cards.values()) {
          if (card.did !== undefined && subjects.includes(card.did)) targets.add(card.agentId);
        }
      });
      const gone: string[] = [];
      for (const agentId of targets) {
        await onAgent(agentId, () => exclusive(async () => {
          reserved.delete(agentId);
          const had = cards.delete(agentId);
          if (!had) return;
          gone.push(agentId);
          try { if (deps.store) await deps.store.remove(agentId); }
          catch (err) { deps.log?.(`[agent-directory] index remove failed: ${(err as Error).message}`); }
        }));
      }
      return gone;
    },

    async searchAgents(args) {
      const q = typeof args['q'] === 'string' ? args['q'] : '';
      const found = snapshot(q);
      return json({ query: q, total: found.length, agents: found.map(card => wireCard(card, deps.notifyTarget, base)) });
    },

    async getAgentCard(args) {
      const id = typeof args['agent_id'] === 'string' ? args['agent_id'].trim() : '';
      if (!AGENT_ID.test(id)) return json({ error: 'invalid_agent', code: 400, message: 'agent_id must be the agent\'s own pod id.' });
      const card = cards.get(id);
      if (!card) return json({ error: 'no_such_agent', code: 404, message: 'No published card for that agent.' });
      return json(wireCard(card, deps.notifyTarget, base));
    },

    async requestWork(args) {
      const caller = deps.callerOf(args);
      if (!caller || !AGENT_ID.test(caller.agentId)) {
        return json({ error: 'authentication_required', code: 401, message: 'Sign in to send work. The directory will not send it as anyone else.' });
      }
      const summary = typeof args['summary'] === 'string' ? args['summary'].trim() : '';
      const content = typeof args['content'] === 'string' ? args['content'] : '';
      if (summary.length < 1 || summary.length > 280) {
        return json({ error: 'invalid_work', code: 400, message: 'summary must be 1–280 characters.' });
      }
      if (content.length > 8000) {
        return json({ error: 'invalid_work', code: 400, message: 'content must be at most 8000 characters.' });
      }
      const secret = screenedText([summary, content]);
      if (secret) {
        return json({ error: 'secret_refused', code: 400, message: 'Refusing to send work that contains a credential or secret.' });
      }
      const to = typeof args['to'] === 'string' ? args['to'].trim() : '';
      const card = resolveTarget(to, [...cards.values()], base);
      if (!card) {
        return json({ error: 'no_such_agent', code: 404, message: 'No published card matches that recipient. Nothing was sent.' });
      }
      const about = typeof args['about'] === 'string' && args['about'].trim() ? args['about'].trim() : undefined;
      if (about && turtleIriRef(about) === null) {
        return json({ error: 'invalid_work', code: 400, message: 'about must be an IRI.' });
      }
      const delivered = await deps.notify({
        ...sessionFields(args),
        to: card.relayAddress,
        summary,
        ...(content ? { content } : {}),
        ...(about ? { about } : {}),
        type: 'Offer',
      });
      let receipt: unknown = delivered;
      try { receipt = JSON.parse(delivered); } catch { receipt = { delivered: false, raw: 'unreadable' }; }
      return json({
        routedTo: { agentId: card.agentId, relayAddress: card.relayAddress, ...(card.inbox ? { inbox: card.inbox } : {}) },
        receipt,
      });
    },

    mount(app) {
      const sendHtml = (res: Response, status: number, html: string): void => {
        res.status(status).type('text/html; charset=utf-8').send(html);
      };
      app.get('/directory', (req: Request, res: Response) => {
        const q = typeof req.query['q'] === 'string' ? req.query['q'] : '';
        sendHtml(res, 200, directoryHtml(snapshot(q, SEARCH_LIMIT), q));
      });
      app.get('/directory/agent/:id', (req: Request, res: Response) => {
        const id = String(req.params['id'] ?? '');
        const card = AGENT_ID.test(id) ? cards.get(id) : undefined;
        if (!card) { sendHtml(res, 404, page('No such agent', '<main><h1>No such agent</h1><p><a href="/directory">Back to the directory</a></p></main>')); return; }
        res.setHeader('ETag', `"${card.version}"`);
        sendHtml(res, 200, agentHtml(card, deps.notifyTarget));
      });
      app.get('/directory/agents', (req: Request, res: Response) => {
        const q = typeof req.query['q'] === 'string' ? req.query['q'] : '';
        const found = snapshot(q);
        res.json({ query: q, total: found.length, agents: found.map(card => wireCard(card, deps.notifyTarget, base)) });
      });
      app.get('/directory/agents/:id', (req: Request, res: Response) => {
        const id = String(req.params['id'] ?? '');
        const card = AGENT_ID.test(id) ? cards.get(id) : undefined;
        if (!card) { res.status(404).json({ error: 'no_such_agent', message: 'No published card for that agent.' }); return; }
        res.setHeader('ETag', `"${card.version}"`);
        const describedBy = turtleIriRef(card.cardIri);
        if (describedBy) res.setHeader('Link', describedBy + '; rel="describedby"');
        res.json(wireCard(card, deps.notifyTarget, base));
      });
    },
  };
}

function resolveTarget(to: string, all: readonly PublicAgentCard[], base: string): PublicAgentCard | undefined {
  if (!to) return undefined;
  const byId = all.find(card => card.agentId === to);
  if (byId) return byId;
  return all.find(card => card.cardIri === to || card.relayAddress === to || to === `${base}/agents/${card.agentId}`);
}
