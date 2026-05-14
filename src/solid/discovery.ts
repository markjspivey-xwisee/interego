/**
 * @module solid/discovery
 * @description Unified identifier resolver + progressive-opt-in discovery
 * per spec/architecture.md §6.5d.
 *
 * Seven tiers, each independently useful, each OPT-IN:
 *
 *   T0 — Raw pod URL sharing. You give someone the URL; they read
 *        the manifest. Works today; no opt-in.
 *   T1 — DID-Web anchoring. Publish DID document at
 *        <domain>/.well-known/did.json. Consumers resolve
 *        did:web:<domain> → document → storage endpoint.
 *   T2 — WebFinger. Publish at <domain>/.well-known/webfinger.
 *        Consumers resolve acct:you@<domain> → href → WebID.
 *   T3 — .well-known/interego-agents catalog. Publish a list of
 *        your pods + agents at a domain-level well-known URL.
 *        Consumers enumerate without knowing specific pods.
 *   T4 — Federation-directory descriptor. Publish a descriptor
 *        conforming to federation-directory-v1 aggregating
 *        pods + agents + shapes + affordances you want public.
 *        Any pod can host one; consumers find them via
 *        discover_context.
 *   T5 — Social-graph walk. Given one seed URL, BFS outward via
 *        prov:wasDerivedFrom citations. No publisher opt-in needed —
 *        the citation graph is implicit.
 *   T6 — On-chain registry (ERC-8004 T0-T3). Your DID + agent
 *        identity on a public chain. Consumers query the chain.
 *
 * This module provides `resolveIdentifier(id)` that branches by
 * identifier kind (DID / acct / URL) and tries each applicable
 * tier, returning whatever it finds.
 */

import type { FetchFn } from './types.js';
import { getDefaultFetch } from './client.js';
import { resolveDidWeb, findStorageEndpoint } from './did.js';
import { resolveWebFinger } from './webfinger.js';

const TURTLE_CONTENT_TYPE = 'text/turtle';
const JSONLD_CONTENT_TYPE = 'application/ld+json';

/** Conventional path for a domain-level agents catalog. */
export const WELL_KNOWN_AGENTS_PATH = '.well-known/interego-agents';

// ── Discovery result shape ──────────────────────────────────

export interface DiscoveryResult {
  /** The identifier that was resolved. */
  readonly identifier: string;
  /** Kind of identifier detected. */
  readonly kind: 'did' | 'acct' | 'url' | 'unknown';
  /** Resolved WebID, if found via any tier. */
  readonly webId?: string;
  /** Resolved pod URL, if found. */
  readonly podUrl?: string;
  /** Well-known agents catalog URL, if found. */
  readonly agentsCatalogUrl?: string;
  /** Agents listed in the catalog (T3). */
  readonly agents?: readonly AgentCatalogEntry[];
  /** Tiers that produced signal for this identifier. */
  readonly tiersHit: readonly DiscoveryTier[];
  /** Raw diagnostic details per tier. */
  readonly trace?: Record<DiscoveryTier, string>;
}

export type DiscoveryTier = 'T0' | 'T1' | 'T2' | 'T3' | 'T4' | 'T5' | 'T6';

export interface AgentCatalogEntry {
  readonly agentId: string;
  readonly webId?: string;
  readonly podUrl?: string;
  readonly label?: string;
  readonly capabilities?: readonly string[];
}

// ── .well-known/interego-agents (T3) ───────────────────────

/**
 * Fetch a domain's `.well-known/interego-agents` catalog if present.
 * Returns the parsed entries or null if the catalog isn't published.
 *
 * Accepts either JSON-LD or Turtle. The expected shape:
 *
 * ```turtle
 * <urn:catalog> a cg:AgentCatalog ;
 *     cg:hasAgent [
 *         a cg:AuthorizedAgent ;
 *         cg:agentIdentity <did:web:bob.example.com> ;
 *         foaf:name "Bob's coding agent" ;
 *         cg:podUrl <https://bob.example.com/pod/> ;
 *         cg:capability cg:canPublish , cg:canAudit
 *     ] .
 * ```
 */
export async function fetchWellKnownAgents(
  domainOrUrl: string,
  options: { fetch?: FetchFn } = {},
): Promise<{ url: string; entries: readonly AgentCatalogEntry[]; error?: string } | null> {
  const fetchFn = options.fetch ?? getDefaultFetch();
  const base = domainOrUrl.startsWith('http') ? domainOrUrl : `https://${domainOrUrl}`;
  const stripped = base.replace(/\/+$/, '');
  const url = `${stripped}/${WELL_KNOWN_AGENTS_PATH}`;

  // Returns:
  //   { url, entries: [...] }            — success (catalog published, entries valid)
  //   { url, entries: [], error: "..." } — catalog not published OR fetch failed.
  //                                         The error message surfaces the root
  //                                         cause to callers; an empty array
  //                                         alone is ambiguous (no catalog vs.
  //                                         catalog exists but empty).
  //
  // We deliberately return a typed result with error info rather than
  // `null` on failure so consumers can distinguish "domain has no
  // agents catalog" from "domain unreachable" from "catalog malformed."
  // Past behaviour was a silent `null`, which masked DNS / pod-down
  // / config errors as "no agents found" — the reliability audit
  // flagged this as a high-likelihood support-ticket shape.
  try {
    const resp = await fetchFn(url, {
      method: 'GET',
      headers: { Accept: `${TURTLE_CONTENT_TYPE}, ${JSONLD_CONTENT_TYPE}` },
    });
    if (!resp.ok) {
      // 404 is the common case: domain exists but no catalog. Distinct
      // from connection failures (network / TLS / DNS).
      return { url, entries: [], error: `catalog not published (HTTP ${resp.status})` };
    }
    const body = await resp.text();
    const entries = parseAgentsCatalog(body);
    return { url, entries };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { url, entries: [], error: `catalog fetch failed: ${reason}` };
  }
}

/**
 * Parse an agents catalog Turtle document. Regex-based (same design
 * choice as elsewhere in the codebase; narrow shape, zero runtime
 * deps). Tolerates missing optional fields.
 */
export function parseAgentsCatalog(ttl: string): readonly AgentCatalogEntry[] {
  const entries: AgentCatalogEntry[] = [];
  // Match `cg:hasAgent [ ... ]` blocks.
  const re = /cg:hasAgent\s+\[([\s\S]*?)\]\s*(?:[;.])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(ttl)) !== null) {
    const body = m[1]!;
    const idM = body.match(/cg:agentIdentity\s+<([^>]+)>/);
    if (!idM) continue;
    const webIdM = body.match(/cg:webId\s+<([^>]+)>/)
      ?? body.match(/foaf:webid\s+<([^>]+)>/i);
    const podM = body.match(/cg:podUrl\s+<([^>]+)>/);
    const nameM = body.match(/foaf:name\s+"([^"]+)"/);
    const capMatches = [...body.matchAll(/cg:capability\s+((?:\S+\s*,\s*)*\S+)/g)];
    const capabilities: string[] = [];
    for (const cm of capMatches) {
      const list = cm[1]!.split(/\s*,\s*/);
      for (const cap of list) capabilities.push(cap.trim());
    }
    entries.push({
      agentId: idM[1]!,
      webId: webIdM?.[1],
      podUrl: podM?.[1],
      label: nameM?.[1],
      capabilities: capabilities.length > 0 ? capabilities : undefined,
    });
  }
  return entries;
}

/**
 * Build the Turtle for a `.well-known/interego-agents` catalog.
 * Domain operators PUT the result at
 * `<domain>/.well-known/interego-agents`.
 */
export function agentsCatalogTurtle(
  catalogIri: string,
  entries: readonly AgentCatalogEntry[],
): string {
  const lines = [
    '@prefix cg: <https://markjspivey-xwisee.github.io/interego/ns/cg#> .',
    '@prefix foaf: <http://xmlns.com/foaf/0.1/> .',
    '',
    `<${catalogIri}> a cg:AgentCatalog ;`,
  ];
  for (const e of entries) {
    const parts: string[] = [
      `    cg:hasAgent [`,
      `        a cg:AuthorizedAgent ;`,
      `        cg:agentIdentity <${e.agentId}> ;`,
    ];
    if (e.label) parts.push(`        foaf:name "${e.label.replace(/"/g, '\\"')}" ;`);
    if (e.webId) parts.push(`        cg:webId <${e.webId}> ;`);
    if (e.podUrl) parts.push(`        cg:podUrl <${e.podUrl}> ;`);
    if (e.capabilities && e.capabilities.length > 0) {
      parts.push(`        cg:capability ${e.capabilities.join(' , ')} ;`);
    }
    // Remove trailing ; from last prop inside the blank node
    parts[parts.length - 1] = parts[parts.length - 1]!.replace(/ ;$/, ' ');
    parts.push(`    ] ;`);
    lines.push(...parts);
  }
  // Replace trailing ; with .
  const last = lines.length - 1;
  lines[last] = lines[last]!.replace(/ ;$/, ' .');
  return lines.join('\n');
}

// ── Unified resolver ───────────────────────────────────────

function detectKind(id: string): DiscoveryResult['kind'] {
  if (id.startsWith('did:')) return 'did';
  if (id.startsWith('acct:')) return 'acct';
  if (id.startsWith('http://') || id.startsWith('https://')) return 'url';
  return 'unknown';
}

/**
 * Resolve any identifier into a `DiscoveryResult` by trying every
 * applicable tier. Never throws; returns an empty result with
 * kind='unknown' when nothing matches.
 *
 * This is the recommended entry point for consumers who have an
 * identifier and want "everything you can find about this principal."
 */
export async function resolveIdentifier(
  id: string,
  options: { fetch?: FetchFn; maxDepth?: number } = {},
): Promise<DiscoveryResult> {
  const kind = detectKind(id);
  const trace: Partial<Record<DiscoveryTier, string>> = {};
  const tiersHit: DiscoveryTier[] = [];
  let webId: string | undefined;
  let podUrl: string | undefined;
  let agentsCatalogUrl: string | undefined;
  let agents: readonly AgentCatalogEntry[] | undefined;

  // Extract domain for T3 well-known lookup (for did:web and acct:)
  let domain: string | undefined;
  if (kind === 'did' && id.startsWith('did:web:')) {
    domain = id.slice('did:web:'.length).split(':')[0];
  } else if (kind === 'acct') {
    const m = id.match(/^acct:[^@]+@(.+)$/);
    if (m) domain = m[1];
  } else if (kind === 'url') {
    try { domain = new URL(id).hostname; } catch { /* ignore */ }
  }

  // T1 — DID-Web
  if (kind === 'did' && id.startsWith('did:web:')) {
    try {
      const didRes = await resolveDidWeb(id, options);
      if (didRes?.didDocument) {
        trace.T1 = 'did document resolved';
        tiersHit.push('T1');
        const storage = findStorageEndpoint(didRes.didDocument);
        if (storage) { podUrl = storage; }
      }
    } catch (e) {
      trace.T1 = `did-web resolve failed: ${(e as Error).message}`;
    }
  }

  // T2 — WebFinger
  if (kind === 'acct') {
    try {
      const wf = await resolveWebFinger(id, options);
      if (wf) {
        trace.T2 = 'webfinger resolved';
        tiersHit.push('T2');
        const selfLink = wf.links?.find(l => l.rel === 'self' || l.rel === 'http://webfinger.net/rel/profile-page');
        if (selfLink?.href) {
          webId = selfLink.href;
          // If we got a profile page, fetch it to find pod URL
          if (!podUrl) {
            try {
              const fetchFn = options.fetch ?? getDefaultFetch();
              const pr = await fetchFn(webId, { method: 'GET', headers: { Accept: TURTLE_CONTENT_TYPE } });
              if (pr.ok) {
                const body = await pr.text();
                const storageMatch = body.match(/(?:solid:storage|pim:storage)\s+<([^>]+)>/);
                if (storageMatch) podUrl = storageMatch[1]!;
              }
            } catch { /* ignore */ }
          }
        }
      }
    } catch (e) {
      trace.T2 = `webfinger resolve failed: ${(e as Error).message}`;
    }
  }

  // T3 — .well-known/interego-agents
  //
  // Canonical per RFC 8615 is domain-level
  // (<domain>/.well-known/interego-agents). But many Solid
  // deployments host multiple pods under one domain via path
  // prefixes (e.g. https://host/alice/, https://host/bob/);
  // in that case there can ALSO be a per-pod catalog at
  // <pod>/.well-known/interego-agents. Resolver checks both,
  // preferring domain-level when found.
  const wellKnownBases: string[] = [];
  if (domain) wellKnownBases.push(`https://${domain}`);
  if (podUrl) {
    const podBase: string = podUrl;
    if (!wellKnownBases.some(b => b.startsWith(podBase) || podBase.startsWith(b))) {
      wellKnownBases.push(podBase.replace(/\/$/, ''));
    }
  }
  if (!podUrl && kind === 'url' && id.startsWith('http')) {
    const stripped = id.replace(/\/+$/, '');
    if (!wellKnownBases.includes(stripped)) wellKnownBases.push(stripped);
  }

  for (const base of wellKnownBases) {
    try {
      const catalog = await fetchWellKnownAgents(base, options);
      if (catalog && catalog.entries.length > 0) {
        trace.T3 = `agents catalog at ${base} (${catalog.entries.length} entries)`;
        if (!tiersHit.includes('T3')) tiersHit.push('T3');
        agentsCatalogUrl = catalog.url;
        agents = catalog.entries;
        if (!podUrl) {
          const withPod = catalog.entries.find(e => e.podUrl);
          if (withPod) podUrl = withPod.podUrl;
        }
        break;  // first hit wins (prefers domain-level)
      }
    } catch (e) {
      trace.T3 = `agents catalog failed at ${base}: ${(e as Error).message}`;
    }
  }

  // T0 — raw pod URL detection
  if (kind === 'url' && !podUrl) {
    // Heuristic: if the URL resolves and has a /.well-known/context-graphs,
    // it's a pod URL.
    try {
      const fetchFn = options.fetch ?? getDefaultFetch();
      const manifestUrl = id.endsWith('/') ? `${id}.well-known/context-graphs` : `${id}/.well-known/context-graphs`;
      const mr = await fetchFn(manifestUrl, { method: 'GET', headers: { Accept: TURTLE_CONTENT_TYPE } });
      if (mr.ok) {
        podUrl = id.endsWith('/') ? id : `${id}/`;
        tiersHit.push('T0');
        trace.T0 = 'pod manifest reachable';
      }
    } catch { /* ignore */ }
  }

  return {
    identifier: id,
    kind,
    webId,
    podUrl,
    agentsCatalogUrl,
    agents,
    tiersHit,
    trace: trace as Record<DiscoveryTier, string>,
  };
}
