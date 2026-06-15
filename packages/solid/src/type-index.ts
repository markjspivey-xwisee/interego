/**
 * type-index.ts — shape-driven, per-agent, hypermedia-resolved storage.
 *
 * Foundation-first principle (PGSL is the substrate; W3C/Solid are projections):
 * an agent's WebID profile advertises WHERE it stores data of a given SHAPE, and
 * peers/apps discover that by FOLLOWING the agent's own hypermedia — never by a
 * hardcoded container path. This is the Solid Type Index:
 *
 *   <profile#me> solid:publicTypeIndex <…/publicTypeIndex.ttl> .
 *   <#reg> a solid:TypeRegistration ;
 *          solid:forClass <shape> ;
 *          solid:instanceContainer <…/where/this/shape/lives/> .
 *
 * An app (the TTT game, Foxxi) references only the SHAPE; the substrate reads the
 * subject agent's OWN profile to resolve placement — so johnny may store a shape
 * somewhere/however differently than boozer, each self-sovereign.
 *
 * NON-BREAKING MIGRATION: if an agent has not registered a shape, resolution
 * falls back to a conventional default container (the prior hardcoded behavior),
 * so existing flows keep working while agents progressively self-describe. The
 * resolver also accepts a conventional `settings/publicTypeIndex.ttl` even when
 * the profile doesn't yet link it, so seeding doesn't require rewriting profiles.
 */
import type { IRI } from '@interego/core';
import { getDefaultFetch, type FetchFn } from '@interego/core/http';

const SOLID = 'http://www.w3.org/ns/solid/terms#';
const PIM = 'http://www.w3.org/ns/pim/space#';
const TURTLE = 'text/turtle';
const CONVENTIONAL_TYPE_INDEX = 'settings/publicTypeIndex.ttl';

function withSlash(u: string): string { return u.endsWith('/') ? u : `${u}/`; }
function escapeRe(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** First object IRI of any of `preds` (prefixed `solid:x` or full `<NS x>`). */
function readIri(turtle: string, preds: Array<{ prefixed: string; full: string }>): string | undefined {
  for (const p of preds) {
    const m = turtle.match(new RegExp(`(?:${escapeRe(p.prefixed)}|<${escapeRe(p.full)}>)\\s+<([^>]+)>`));
    if (m) return m[1];
  }
  return undefined;
}

/**
 * Resolve the agent's profile/WebID document URL. Accepts a WebID (with or
 * without a fragment), a profile/card URL, or a pod root URL.
 */
function profileDocFor(agent: string): { profileDoc: string; podGuess: string } {
  const noFrag = agent.includes('#') ? agent.slice(0, agent.indexOf('#')) : agent;
  if (/\/profile\/card$/.test(noFrag) || /\/profile$/.test(noFrag)) {
    const podGuess = noFrag.replace(/profile\/card$/, '').replace(/profile$/, '');
    return { profileDoc: noFrag, podGuess: withSlash(podGuess) };
  }
  // Treat as a pod root.
  const pod = withSlash(noFrag);
  return { profileDoc: `${pod}profile/card`, podGuess: pod };
}

/** Find the TypeRegistration for `shapeClass` and return its container/instance. */
function registrationTargetFor(typeIndexTtl: string, shapeClass: string): string | undefined {
  // Each registration is a single statement terminated by ` . `.
  for (const stmt of typeIndexTtl.split(/\s\.\s/)) {
    const forClass = new RegExp(`(?:solid:forClass|<${escapeRe(SOLID)}forClass>)\\s+<${escapeRe(shapeClass)}>`);
    if (!forClass.test(stmt)) continue;
    const target = stmt.match(/(?:solid:instanceContainer|<[^>]*#instanceContainer>)\s+<([^>]+)>/)
                || stmt.match(/(?:solid:instance|<[^>]*#instance>)\s+<([^>]+)>/);
    if (target) return target[1];
  }
  return undefined;
}

export interface StorageResolution {
  /** Absolute container (or instance) URL where this shape lives for this agent. */
  readonly target: string;
  /** How it was resolved: the agent's own Type Index, or the convention fallback. */
  readonly source: 'type-index' | 'fallback';
  /** The agent's pod storage root, when determinable. */
  readonly podRoot: string;
}

export interface ResolveStorageOptions {
  readonly fetch?: FetchFn;
  /**
   * Container (relative to the pod root) to use when the agent has not
   * registered this shape. Preserves prior hardcoded placement for a
   * non-breaking migration — e.g. 'foxxi-wallet/' for credentials.
   */
  readonly defaultContainer?: string;
}

/**
 * Resolve where data of `shapeClass` should be stored / read for `agent`, by
 * following the agent's own Solid Type Index (hypermedia), falling back to a
 * conventional default container. Apps pass the SHAPE, not a path.
 */
export async function resolveStorageForShape(
  agent: string,
  shapeClass: IRI | string,
  opts: ResolveStorageOptions = {},
): Promise<StorageResolution> {
  const fetchFn = opts.fetch ?? getDefaultFetch();
  const { profileDoc, podGuess } = profileDocFor(agent);

  let profileTtl = '';
  try {
    const r = await fetchFn(profileDoc, { method: 'GET', headers: { Accept: TURTLE } });
    if (r.ok) profileTtl = await r.text();
  } catch { /* profile unreadable — fall through to convention */ }

  // Pod root: anchor on the host/path the caller reached the agent on. A
  // profile's advertised pim:storage *host* can be stale/unreachable (e.g. a
  // legacy bare-external CSS FQDN), so it isn't authoritative for resolution;
  // the profile's real role here is the Type Index (shape -> container) read
  // below. We keep the advertised storage PATH when same-origin as the caller.
  const callerOrigin = (() => { try { return new URL(podGuess).origin; } catch { return ''; } })();
  const advertisedStorage = readIri(profileTtl, [
    { prefixed: 'pim:storage', full: `${PIM}storage` },
    { prefixed: 'solid:storage', full: `${SOLID}storage` },
  ]);
  const storagePath = (() => {
    try { return new URL(advertisedStorage ?? podGuess).pathname; } catch { return new URL(podGuess).pathname; }
  })();
  const podRoot = withSlash(callerOrigin ? `${callerOrigin}${storagePath}` : podGuess);

  // Type Index: prefer the profile's advertised one; else the conventional path.
  const advertised = readIri(profileTtl, [{ prefixed: 'solid:publicTypeIndex', full: `${SOLID}publicTypeIndex` }]);
  const typeIndexCandidates = [
    advertised ? new URL(advertised, profileDoc).toString() : undefined,
    `${podRoot}${CONVENTIONAL_TYPE_INDEX}`,
  ].filter(Boolean) as string[];

  for (const tiUrl of typeIndexCandidates) {
    try {
      const r = await fetchFn(tiUrl, { method: 'GET', headers: { Accept: TURTLE } });
      if (!r.ok) continue;
      const target = registrationTargetFor(await r.text(), String(shapeClass));
      if (target) return { target: new URL(target, tiUrl).toString(), source: 'type-index', podRoot };
    } catch { /* try next candidate */ }
  }

  const def = opts.defaultContainer ?? 'context-graphs/';
  return { target: withSlash(new URL(def, podRoot).toString()), source: 'fallback', podRoot };
}

/**
 * Register (self-describe) that `shapeClass` is stored at `container` for this
 * agent — writes a TypeRegistration into the agent's public Type Index. Requires
 * a write-authorized `fetch`. Idempotent on the shape (replaces a prior reg).
 * This is how an agent declares "my data of this shape lives here," which
 * resolveStorageForShape (and any peer) then follows via hypermedia.
 */
export async function registerShapeStorage(
  agentPod: string,
  shapeClass: IRI | string,
  container: string,
  opts: { fetch?: FetchFn; linkProfile?: boolean } = {},
): Promise<{ typeIndexUrl: string; container: string }> {
  const fetchFn = opts.fetch ?? getDefaultFetch();
  const pod = withSlash(agentPod);
  const typeIndexUrl = `${pod}${CONVENTIONAL_TYPE_INDEX}`;
  const containerAbs = withSlash(new URL(container, pod).toString());
  const shape = String(shapeClass);

  let existing = '';
  try { const r = await fetchFn(typeIndexUrl, { method: 'GET', headers: { Accept: TURTLE } }); if (r.ok) existing = await r.text(); } catch { /* fresh */ }

  // Drop any prior registration for this shape (re-register idempotently).
  const kept = existing
    .split(/\s\.\s/)
    .map(s => s.trim())
    .filter(s => s && !new RegExp(`(?:solid:forClass|<${escapeRe(SOLID)}forClass>)\\s+<${escapeRe(shape)}>`).test(s)
              && /TypeRegistration/.test(s));

  const slug = shape.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'reg';
  const header = `@prefix solid: <${SOLID}> .\n@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .\n\n<${typeIndexUrl}> a solid:TypeIndex, solid:ListedDocument .`;
  const reg = `<${typeIndexUrl}#reg-${slug}> a solid:TypeRegistration ;\n    solid:forClass <${shape}> ;\n    solid:instanceContainer <${containerAbs}> .`;
  const body = `${header}\n\n${kept.map(s => `${s} .`).join('\n\n')}${kept.length ? '\n\n' : ''}${reg}\n`;

  const put = await fetchFn(typeIndexUrl, { method: 'PUT', headers: { 'Content-Type': TURTLE }, body });
  if (!put.ok) throw new Error(`type index PUT <${typeIndexUrl}> -> ${put.status} ${put.statusText}`);

  // Best-effort: link the Type Index from the profile (proper-Solid discovery).
  // Gated by linkProfile (default on) — callers can skip to avoid touching a
  // live profile card; resolution still works via the conventional path.
  if (opts.linkProfile !== false) try {
    const cardUrl = `${pod}profile/card`;
    const cr = await fetchFn(cardUrl, { method: 'GET', headers: { Accept: TURTLE } });
    if (cr.ok) {
      const card = await cr.text();
      if (!/publicTypeIndex/.test(card)) {
        const patched = card.replace(/(<[^>]*#me>\s)/, `$1    solid:publicTypeIndex <${typeIndexUrl}> ;\n`);
        if (patched !== card) {
          const withPrefix = /@prefix solid:/.test(patched) ? patched : `@prefix solid: <${SOLID}> .\n${patched}`;
          await fetchFn(cardUrl, { method: 'PUT', headers: { 'Content-Type': TURTLE }, body: withPrefix }).catch(() => {});
        }
      }
    }
  } catch { /* profile link is an enhancement; the conventional path still resolves */ }

  return { typeIndexUrl, container: containerAbs };
}
