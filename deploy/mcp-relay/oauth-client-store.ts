/**
 * @module oauth-client-store
 * @description Persistent storage for OAuth Dynamic Client Registration
 *              entries, expressed as typed Context Descriptors on the
 *              maintainer's Solid pod.
 *
 * Background:
 *   The MCP relay implements RFC 7591 Dynamic Client Registration so
 *   that ChatGPT, claude.ai, and similar OAuth-aware clients can self-
 *   provision a client_id. The provider used to keep those registrations
 *   in a process-local `Map`, so every container restart silently
 *   invalidated every previously-issued client_id — the next request
 *   from each existing client got back {"error":"invalid_client"}.
 *
 *   This module persists each registration as its own Context Descriptor
 *   on the maintainer's pod. The descriptor's named-graph block carries
 *   each RFC 7591 registration field as its own typed triple under a
 *   relay-scoped predicate (e.g. `relay:clientName`, `relay:redirectUri`,
 *   `relay:grantType`), so the body is queryable by SPARQL rather than
 *   opaque JSON. The AccessControl facet restricts reads to the relay's
 *   own DID — the maintainer never accidentally exposes client secrets
 *   to the wider federation.
 *
 * Design notes:
 *   - One descriptor per client. Slug is `oauth-client-<client_id>`. The
 *     client_id is hex from randomBytes(16) and is therefore a safe slug.
 *   - All pod IO is wrapped in `withTransientRetry` from @interego/core
 *     so a transient CSS hiccup doesn't lose a registration.
 *   - On cold-start (no descriptors yet, manifest absent), `loadClients`
 *     returns an empty `Map` rather than throwing.
 *   - No new core/cg:/cgh:/pgsl: ontology terms are introduced. The
 *     scenario predicates and class `relay:OAuthClient` live under a
 *     non-owned scenario namespace so ontology-lint stays green.
 *   - The graph block is plaintext on the pod by design: encryption with
 *     `publish(..., { encrypt })` would require the maintainer to have
 *     already registered the relay's X25519 key in its agents.ttl, which
 *     it can't do until the relay is up. The AccessControl ABAC grant is
 *     the access-restriction story; the storage layer (CSS) enforces
 *     reads via ACL/WAC on the maintainer's pod.
 *   - The relay's DID uses the project-wide convention
 *     `did:key:<lowercased-addr>#mcp-relay` — same shape as every other
 *     Interego agent (Foxxi bridge-signer, the collective watchers, the
 *     examples/emergent pilgrim wallets). See `src/passport/wallet.ts`.
 */

import type {
  OAuthClientInformationFull,
} from '@modelcontextprotocol/sdk/shared/auth.js';

import {
  ContextDescriptor,
  type FetchFn,
  findSubjectsOfType,
  type IRI,
  type ParsedSubject,
  parseTrig,
  readStringValue,
  readStringValues,
  withTransientRetry,
} from '@interego/core';
import {
  discover,
  fetchGraphContent,
  publish,
} from '@interego/solid';

// ── Scenario namespace ──────────────────────────────────────
// Deliberately under a non-owned namespace per the codebase's ontology-
// hygiene rule: do NOT mint new cg:/cgh:/pgsl: terms. This vocabulary
// is private to the MCP relay's persistence concern; it is not part of
// L1/L2/L3 of the Interego protocol.
//
// Each `relay:` predicate maps 1:1 onto a single RFC 7591 / OAuth 2.1
// DCR field. Repeated fields (redirect_uris, grant_types, response_types)
// become repeated triples; scalar fields become single triples. This
// keeps the graph SPARQL-queryable — `?c relay:redirectUri ?u` returns
// every redirect_uri across every registered client without app-code
// JSON parsing.
const RELAY_NS = 'https://interego-emergent.example/ns/mcp-relay#';
const RELAY_OAUTH_CLIENT_TYPE   = `${RELAY_NS}OAuthClient`             as IRI;
// Scalar fields
const RELAY_CLIENT_ID           = `${RELAY_NS}clientId`                as IRI;
const RELAY_CLIENT_SECRET       = `${RELAY_NS}clientSecret`            as IRI;
const RELAY_CLIENT_ID_ISSUED_AT = `${RELAY_NS}clientIdIssuedAt`        as IRI;
const RELAY_CLIENT_SECRET_EXPIRES_AT = `${RELAY_NS}clientSecretExpiresAt` as IRI;
const RELAY_CLIENT_NAME         = `${RELAY_NS}clientName`              as IRI;
const RELAY_SCOPE               = `${RELAY_NS}scope`                   as IRI;
const RELAY_TOKEN_ENDPOINT_AUTH_METHOD = `${RELAY_NS}tokenEndpointAuthMethod` as IRI;
const RELAY_CLIENT_URI          = `${RELAY_NS}clientUri`               as IRI;
const RELAY_LOGO_URI            = `${RELAY_NS}logoUri`                 as IRI;
const RELAY_SOFTWARE_ID         = `${RELAY_NS}softwareId`              as IRI;
const RELAY_SOFTWARE_VERSION    = `${RELAY_NS}softwareVersion`         as IRI;
// Repeated fields (one triple per value)
const RELAY_REDIRECT_URI        = `${RELAY_NS}redirectUri`             as IRI;
const RELAY_GRANT_TYPE          = `${RELAY_NS}grantType`               as IRI;
const RELAY_RESPONSE_TYPE       = `${RELAY_NS}responseType`            as IRI;

// XSD datatype IRIs — written as full IRIs in the Turtle so the graph
// block doesn't need a `@prefix xsd:` directive.
const XSD_STRING   = 'http://www.w3.org/2001/XMLSchema#string';
const XSD_DATETIME = 'http://www.w3.org/2001/XMLSchema#dateTime';
const XSD_ANYURI   = 'http://www.w3.org/2001/XMLSchema#anyURI';
const XSD_INTEGER  = 'http://www.w3.org/2001/XMLSchema#integer';

// LDP container the descriptors land in. Matches the substrate's default
// (`context-graphs/`) — same place every other descriptor goes.
const DEFAULT_CONTAINER = 'context-graphs/';

// ── Helpers ─────────────────────────────────────────────────

function ensureTrailingSlash(s: string): string {
  return s.endsWith('/') ? s : `${s}/`;
}

/**
 * Maintainer's pod URL — where the OAuth client registrations are
 * stored. Defaults to `${CSS_URL}markj/` (the maintainer's pod on the
 * existing CSS deployment), overridable via RELAY_OAUTH_STORE_POD.
 */
export function resolveMaintainerPodUrl(cssUrl: string): string {
  const fromEnv = process.env['RELAY_OAUTH_STORE_POD'];
  if (fromEnv && fromEnv.trim().length > 0) {
    return ensureTrailingSlash(fromEnv.trim());
  }
  return `${ensureTrailingSlash(cssUrl)}markj/`;
}

/**
 * Escape an arbitrary string for inclusion as a Turtle double-quoted
 * literal. We always emit a `"…"` literal, so the only characters that
 * need escaping are `\`, `"`, and ASCII control characters. Newlines /
 * tabs become `\n` / `\t` so each literal stays on a single line — the
 * round-trip through `parseTrig` recovers the original bytes.
 *
 * Used by every `relay:` predicate that takes an xsd:string / xsd:anyURI
 * / xsd:dateTime value.
 */
function escapeTurtleStringLiteral(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const ch = s[i]!;
    switch (ch) {
      case '\\': out += '\\\\'; break;
      case '"': out += '\\"'; break;
      case '\n': out += '\\n'; break;
      case '\r': out += '\\r'; break;
      case '\t': out += '\\t'; break;
      default:
        if (c < 0x20) {
          out += `\\u${c.toString(16).padStart(4, '0').toUpperCase()}`;
        } else {
          out += ch;
        }
    }
  }
  return out;
}

/**
 * Slug for a given client_id. The client_id is hex (from
 * `randomBytes(16).toString('hex')` in the provider) so it's already
 * safe as a path component. The wrapping `oauth-client-` prefix lets
 * curl-verifiers spot the file at a glance.
 */
export function slugForClient(clientId: string): string {
  return `oauth-client-${clientId}`;
}

/** Descriptor IRI for a given client. Stable across restarts. */
function descriptorIdForClient(clientId: string): IRI {
  return `urn:interego:mcp-relay:oauth-client:${clientId}` as IRI;
}

/**
 * Compute the URL `publish()` will write a given client descriptor to.
 * Useful for callers that want to delete the descriptor (we own the
 * slug + container).
 */
function descriptorUrlForClient(podUrl: string, clientId: string): string {
  const pod = ensureTrailingSlash(podUrl);
  return `${pod}${DEFAULT_CONTAINER}${slugForClient(clientId)}.ttl`;
}

function graphUrlForClient(podUrl: string, clientId: string): string {
  const pod = ensureTrailingSlash(podUrl);
  return `${pod}${DEFAULT_CONTAINER}${slugForClient(clientId)}-graph.trig`;
}

/**
 * Build the relay's canonical DID from its ECDSA wallet address.
 *
 * Shape: `did:key:0x<lowercased 20-byte address>#mcp-relay`.
 *
 * This matches the project-wide DID convention (see
 * `src/passport/wallet.ts:loadAgentKeypair`, the `didFor(wallet, label)`
 * helper used across `examples/emergent/*.mjs`, and the DID resolver in
 * `src/solid/did-resolver.ts`). Every Interego agent — Foxxi's bridge
 * signer, the tic-tac-toe collective watcher, the pilgrim examples —
 * expresses its identity this way; using the same shape for the relay
 * means its descriptors and access grants compose with the rest of the
 * federation without any special-case handling.
 *
 * The `#mcp-relay` fragment is the role label, the same way other agents
 * use `#bridge`, `#aggressor`, `#pilgrim`, `#auditor`, etc.
 *
 * The AccessControl facet emitted by `saveClient()` grants Read to
 * exactly this DID and nothing else.
 */
export function relayDidFromAddress(walletAddress: string): IRI {
  return `did:key:${walletAddress.toLowerCase()}#mcp-relay` as IRI;
}

// ── Typed-predicate (de)serialization ───────────────────────

/**
 * Convert a Unix timestamp (seconds, as RFC 7591 specifies for
 * `client_id_issued_at` / `client_secret_expires_at`) into an
 * `xsd:dateTime` ISO-8601 literal. We persist times as dateTime rather
 * than xsd:integer so the graph is human-readable in pod inspections
 * and SPARQL can range-filter by date directly.
 */
function unixSecondsToIsoDateTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString();
}

/**
 * Inverse of `unixSecondsToIsoDateTime`. Tolerant: accepts either an
 * ISO-8601 dateTime literal (the canonical shape) or a bare integer
 * string (in case some other writer dropped a raw Unix seconds value),
 * returning the Unix-seconds integer that RFC 7591 mandates.
 */
function parseDateTimeOrUnixSeconds(s: string): number | undefined {
  const asInt = parseInt(s, 10);
  if (Number.isFinite(asInt) && String(asInt) === s.trim()) {
    return asInt;
  }
  const t = Date.parse(s);
  if (Number.isFinite(t)) {
    return Math.floor(t / 1000);
  }
  return undefined;
}

/**
 * Build the TriG graph body for a single client registration.
 *
 * One subject (the descriptor's `urn:interego:mcp-relay:oauth-client:<id>`)
 * with one triple per RFC 7591 field. Repeated fields (redirect_uris,
 * grant_types, response_types) emit one triple per value. Every literal
 * carries an explicit `^^xsd:…` datatype so the round-trip is lossless
 * even through a strict Turtle parser.
 *
 * No `@prefix` directives — full IRIs throughout — because `publish()`
 * wraps this string in a TriG `<graphIri> { … }` block and document-
 * level prefix decls inside such a block are awkward shape that some
 * parsers don't accept.
 */
function buildGraphContent(
  descId: IRI,
  client: OAuthClientInformationFull,
): string {
  const lines: string[] = [];
  const subj = `<${descId}>`;

  // Type
  lines.push(`${subj} a <${RELAY_OAUTH_CLIENT_TYPE}> ;`);

  const pred = (iri: string) => `<${iri}>`;
  const strLit = (v: string) => `"${escapeTurtleStringLiteral(v)}"`;
  const typedLit = (v: string, dt: string) => `${strLit(v)}^^<${dt}>`;

  // Helper to push one `predicate object ;` line. We always emit the
  // trailing `;` and terminate the subject's property list with a final
  // `.` after the loop — cleaner than tracking last-line state.
  const push = (predIri: string, obj: string) =>
    lines.push(`    ${pred(predIri)} ${obj} ;`);

  // ── Scalars (always present) ─────────────────────────────────
  push(RELAY_CLIENT_ID, typedLit(client.client_id, XSD_STRING));

  if (client.client_secret !== undefined) {
    push(RELAY_CLIENT_SECRET, typedLit(client.client_secret, XSD_STRING));
  }
  if (client.client_id_issued_at !== undefined) {
    push(
      RELAY_CLIENT_ID_ISSUED_AT,
      typedLit(unixSecondsToIsoDateTime(client.client_id_issued_at), XSD_DATETIME),
    );
  }
  if (client.client_secret_expires_at !== undefined) {
    // RFC 7591: 0 means "never expires". Preserve the sentinel as
    // xsd:integer rather than rendering it as 1970-01-01.
    if (client.client_secret_expires_at === 0) {
      push(RELAY_CLIENT_SECRET_EXPIRES_AT, typedLit('0', XSD_INTEGER));
    } else {
      push(
        RELAY_CLIENT_SECRET_EXPIRES_AT,
        typedLit(unixSecondsToIsoDateTime(client.client_secret_expires_at), XSD_DATETIME),
      );
    }
  }
  if (client.client_name !== undefined) {
    push(RELAY_CLIENT_NAME, typedLit(client.client_name, XSD_STRING));
  }
  if (client.scope !== undefined) {
    push(RELAY_SCOPE, typedLit(client.scope, XSD_STRING));
  }
  if (client.token_endpoint_auth_method !== undefined) {
    push(RELAY_TOKEN_ENDPOINT_AUTH_METHOD, typedLit(client.token_endpoint_auth_method, XSD_STRING));
  }
  if (client.client_uri !== undefined) {
    push(RELAY_CLIENT_URI, typedLit(client.client_uri, XSD_ANYURI));
  }
  if (client.logo_uri !== undefined && client.logo_uri !== '') {
    push(RELAY_LOGO_URI, typedLit(client.logo_uri, XSD_ANYURI));
  }
  if (client.software_id !== undefined) {
    push(RELAY_SOFTWARE_ID, typedLit(client.software_id, XSD_STRING));
  }
  if (client.software_version !== undefined) {
    push(RELAY_SOFTWARE_VERSION, typedLit(client.software_version, XSD_STRING));
  }

  // ── Repeated fields ──────────────────────────────────────────
  for (const u of client.redirect_uris ?? []) {
    push(RELAY_REDIRECT_URI, typedLit(u, XSD_ANYURI));
  }
  for (const g of client.grant_types ?? []) {
    push(RELAY_GRANT_TYPE, typedLit(g, XSD_STRING));
  }
  for (const r of client.response_types ?? []) {
    push(RELAY_RESPONSE_TYPE, typedLit(r, XSD_STRING));
  }

  // Terminate the property list. We always emit at least the type +
  // client_id triples, so there's always a trailing `;` to replace.
  const last = lines.pop()!;
  lines.push(last.replace(/;\s*$/, '.'));

  return lines.join('\n');
}

/**
 * Inverse of `buildGraphContent`: read every typed predicate off a
 * `relay:OAuthClient` subject and reconstruct the `OAuthClientInformationFull`
 * value the SDK expects.
 *
 * Returns undefined if the mandatory `relay:clientId` is missing — every
 * other field is optional per RFC 7591 / the SDK's schema.
 */
function reconstructClientFromSubject(
  subject: ParsedSubject,
): OAuthClientInformationFull | undefined {
  const client_id = readStringValue(subject, RELAY_CLIENT_ID);
  if (!client_id) return undefined;

  const redirect_uris = [...readStringValues(subject, RELAY_REDIRECT_URI)];
  const grant_types = [...readStringValues(subject, RELAY_GRANT_TYPE)];
  const response_types = [...readStringValues(subject, RELAY_RESPONSE_TYPE)];

  const issuedAtRaw = readStringValue(subject, RELAY_CLIENT_ID_ISSUED_AT);
  const expiresAtRaw = readStringValue(subject, RELAY_CLIENT_SECRET_EXPIRES_AT);

  // Build the object incrementally so optional-undefined fields don't
  // get serialized back as `key: undefined` (the OAuth SDK's zod schema
  // is strict about that).
  const out: Record<string, unknown> = {
    client_id,
    redirect_uris,
  };

  if (grant_types.length > 0) out.grant_types = grant_types;
  if (response_types.length > 0) out.response_types = response_types;

  const client_secret = readStringValue(subject, RELAY_CLIENT_SECRET);
  if (client_secret !== undefined) out.client_secret = client_secret;

  if (issuedAtRaw !== undefined) {
    const t = parseDateTimeOrUnixSeconds(issuedAtRaw);
    if (t !== undefined) out.client_id_issued_at = t;
  }
  if (expiresAtRaw !== undefined) {
    const t = parseDateTimeOrUnixSeconds(expiresAtRaw);
    if (t !== undefined) out.client_secret_expires_at = t;
  }

  const client_name = readStringValue(subject, RELAY_CLIENT_NAME);
  if (client_name !== undefined) out.client_name = client_name;

  const scope = readStringValue(subject, RELAY_SCOPE);
  if (scope !== undefined) out.scope = scope;

  const tem = readStringValue(subject, RELAY_TOKEN_ENDPOINT_AUTH_METHOD);
  if (tem !== undefined) out.token_endpoint_auth_method = tem;

  const client_uri = readStringValue(subject, RELAY_CLIENT_URI);
  if (client_uri !== undefined) out.client_uri = client_uri;

  const logo_uri = readStringValue(subject, RELAY_LOGO_URI);
  if (logo_uri !== undefined) out.logo_uri = logo_uri;

  const software_id = readStringValue(subject, RELAY_SOFTWARE_ID);
  if (software_id !== undefined) out.software_id = software_id;

  const software_version = readStringValue(subject, RELAY_SOFTWARE_VERSION);
  if (software_version !== undefined) out.software_version = software_version;

  return out as OAuthClientInformationFull;
}

// ── Configuration ────────────────────────────────────────────

export interface OAuthClientStoreConfig {
  /** Maintainer pod URL the descriptors live on. */
  readonly podUrl: string;
  /** Relay's compliance wallet DID (e.g. `did:key:0x…#mcp-relay`). */
  readonly relayDid: IRI;
  /** Optional custom fetch — defaults to the relay's solidFetch. */
  readonly fetch?: FetchFn;
  /** Optional logger — defaults to silent. */
  readonly log?: (msg: string) => void;
}

// ── load ────────────────────────────────────────────────────

/**
 * Read every previously-saved OAuth client registration off the
 * maintainer's pod and return them as a fresh Map.
 *
 * Cold-start safety: if the manifest is absent, returns an empty Map
 * and does NOT throw. Same for the case where the manifest exists but
 * contains zero `relay:OAuthClient` entries.
 *
 * Individual-descriptor failures are logged and skipped — losing one
 * malformed client registration is preferable to crashing the relay's
 * startup and locking out every other registered client.
 */
export async function loadClients(
  cfg: OAuthClientStoreConfig,
): Promise<Map<string, OAuthClientInformationFull>> {
  const log = cfg.log ?? (() => {});
  const out = new Map<string, OAuthClientInformationFull>();

  let entries;
  try {
    entries = await withTransientRetry(
      () => discover(cfg.podUrl, undefined, { fetch: cfg.fetch }),
    );
  } catch (err) {
    log(`[oauth-client-store] discover() failed on ${cfg.podUrl}: ${(err as Error).message}. ` +
        `Starting with an empty client map.`);
    return out;
  }

  // The descriptor carries `dct:conformsTo <relay:OAuthClient>` so the
  // manifest entry mirrors it. Filter by that to avoid fetching every
  // unrelated descriptor on the maintainer's pod.
  const ours = entries.filter(e =>
    (e.conformsTo ?? []).includes(RELAY_OAUTH_CLIENT_TYPE));

  if (ours.length === 0) {
    log(`[oauth-client-store] no OAuth client descriptors found on ${cfg.podUrl}.`);
    return out;
  }

  for (const entry of ours) {
    // Each descriptor publishes one graph IRI — derive the graph URL
    // from the descriptor URL using the slug convention publish() uses.
    // The descriptor's distribution block also points at it, but the
    // convention is stable and saves us a TTL parse on the hot path.
    const descriptorUrl = entry.descriptorUrl;
    const m = descriptorUrl.match(/\/oauth-client-([0-9a-f]+)\.ttl$/);
    if (!m) {
      log(`[oauth-client-store] skipping descriptor with unrecognized slug: ${descriptorUrl}`);
      continue;
    }
    const clientId = m[1]!;
    const graphUrl = graphUrlForClient(cfg.podUrl, clientId);

    try {
      const { content } = await withTransientRetry(() =>
        fetchGraphContent(graphUrl, { fetch: cfg.fetch }));
      if (!content) {
        log(`[oauth-client-store] graph at ${graphUrl} returned no content; skipping ${clientId}.`);
        continue;
      }
      const doc = parseTrig(content);
      const subjects = findSubjectsOfType(doc, RELAY_OAUTH_CLIENT_TYPE);
      if (subjects.length === 0) {
        log(`[oauth-client-store] no relay:OAuthClient subject in ${graphUrl}; skipping ${clientId}.`);
        continue;
      }
      const reconstructed = reconstructClientFromSubject(subjects[0]!);
      if (!reconstructed) {
        log(`[oauth-client-store] could not reconstruct OAuthClientInformationFull ` +
            `from ${graphUrl}; skipping ${clientId}.`);
        continue;
      }
      if (reconstructed.client_id !== clientId) {
        log(`[oauth-client-store] client_id mismatch in ${graphUrl} (descriptor says ${clientId}, ` +
            `payload says ${reconstructed.client_id}); skipping.`);
        continue;
      }
      out.set(clientId, reconstructed);
    } catch (err) {
      log(`[oauth-client-store] failed to read ${graphUrl}: ${(err as Error).message}; skipping.`);
      continue;
    }
  }

  log(`[oauth-client-store] loaded ${out.size} OAuth client registration(s) from ${cfg.podUrl}.`);
  return out;
}

// ── save ────────────────────────────────────────────────────

/**
 * Publish a single OAuth client registration as a typed Context
 * Descriptor on the maintainer's pod. Idempotent on `publish()` re-
 * runs: the manifest CAS step short-circuits when the descriptor URL
 * already appears, and the descriptor + graph PUTs replay cleanly.
 *
 * The AccessControl facet restricts read to the relay's own DID only.
 * No `agentClass acl:AuthenticatedAgent` grant is emitted — the
 * absence of such a grant means readers other than the relay have no
 * authorization under WAC.
 */
export async function saveClient(
  clientId: string,
  clientData: OAuthClientInformationFull,
  cfg: OAuthClientStoreConfig,
): Promise<void> {
  const log = cfg.log ?? (() => {});
  const now = new Date().toISOString();
  const descId = descriptorIdForClient(clientId);
  const graphIri = `urn:interego:mcp-relay:oauth-client-graph:${clientId}` as IRI;

  // The graph body carries every RFC 7591 registration field as its own
  // typed triple under a relay-scoped predicate (built by
  // `buildGraphContent`). One predicate per field = the body is SPARQL-
  // queryable rather than opaque JSON.
  //
  // Full IRIs throughout (no `@prefix` decl) — `publish()` wraps this
  // string in a TriG `<graphIri> { … }` block and document-level prefix
  // directives inside a graph block are an awkward shape that some
  // parsers don't accept. Full IRIs round-trip cleanly through
  // `parseTrig`.
  const graphContent = buildGraphContent(descId, clientData);

  const descriptor = ContextDescriptor.create(descId)
    .describes(graphIri)
    // Temporal — valid from now, indefinitely.
    .temporal({ validFrom: now })
    .validFrom(now)
    // Provenance + Agent — attributed to the relay's compliance DID.
    .delegatedBy(cfg.relayDid, cfg.relayDid, { endedAt: now })
    // AccessControl — ABAC bit: ONLY the relay's DID may read.
    // No agentClass grant; readers other than the relay's DID get no
    // authorization under WAC.
    .accessControl([
      {
        agent: cfg.relayDid,
        mode: ['Read'] as const,
      },
    ])
    // Semiotic — these are factual assertions, ground-truth, full
    // confidence (we minted the client_id literally a moment ago).
    .semiotic({
      modalStatus: 'Asserted',
      groundTruth: true,
      epistemicConfidence: 1.0,
    })
    // Trust — issued by the relay's compliance wallet.
    .trust({
      trustLevel: 'CryptographicallyVerified',
      issuer: cfg.relayDid,
    })
    // Federation — origin + storage are the maintainer's pod.
    .federation({
      origin: cfg.podUrl as IRI,
      storageEndpoint: cfg.podUrl as IRI,
      syncProtocol: 'SolidNotifications',
    })
    // dct:conformsTo so the manifest entry carries the class and the
    // load path can filter to OAuth-client descriptors without
    // fetching every TriG on the pod.
    .conformsTo(RELAY_OAUTH_CLIENT_TYPE)
    .version(1)
    .build();

  await withTransientRetry(async () => {
    await publish(descriptor, graphContent, cfg.podUrl, {
      fetch: cfg.fetch,
      descriptorSlug: slugForClient(clientId),
      graphSlug: `${slugForClient(clientId)}-graph`,
    });
  });

  log(`[oauth-client-store] saved client ${clientId} as ${descriptorUrlForClient(cfg.podUrl, clientId)}.`);
}

// ── delete ──────────────────────────────────────────────────

/**
 * Remove a client's descriptor + graph from the maintainer's pod.
 * Not currently invoked by the OAuth provider, but provided for
 * completeness so an operator can revoke a registration without
 * editing the pod by hand.
 *
 * Best-effort: DELETE on a 404 is fine (already gone). Other errors
 * surface to the caller.
 */
export async function removeClient(
  clientId: string,
  cfg: OAuthClientStoreConfig,
): Promise<void> {
  const log = cfg.log ?? (() => {});
  const fetchFn = cfg.fetch ?? (async (url, init) => {
    const r = await fetch(url, init as RequestInit);
    return {
      ok: r.ok,
      status: r.status,
      statusText: r.statusText,
      headers: { get: (n: string) => r.headers.get(n) },
      text: () => r.text(),
      json: () => r.json(),
    };
  });

  const descUrl = descriptorUrlForClient(cfg.podUrl, clientId);
  const graphUrl = graphUrlForClient(cfg.podUrl, clientId);

  for (const url of [descUrl, graphUrl]) {
    try {
      await withTransientRetry(async () => {
        const r = await fetchFn(url, { method: 'DELETE' });
        if (!r.ok && r.status !== 404) {
          throw new Error(`DELETE ${url} failed: ${r.status} ${r.statusText}`);
        }
      });
    } catch (err) {
      log(`[oauth-client-store] removeClient: ${(err as Error).message}`);
      throw err;
    }
  }
  log(`[oauth-client-store] removed client ${clientId} (${descUrl}).`);
}
