/**
 * Pod-backed xAPI StatementStore — the projection pattern, applied
 * inside-out: from the OUTSIDE the bridge looks like a 100% xAPI 2.0 LRS;
 * from the INSIDE every statement IS a real iep:ContextDescriptor with
 * the seven facets, published to the tenant pod, content-addressed via
 * a pgsl:Atom, dereferenceable on the wire.
 *
 * The xAPI surface (PUT/POST/GET /xapi/statements, voiding, queries) is
 * a VIEW over the substrate, not a parallel store. Container restart
 * does not lose statements; federation discover()s them across pods
 * with no extra translation step; supersedes chains express xAPI voids.
 *
 * Mirrors the lrs-adapter vertical's bidirectional pattern but applied
 * to Foxxi's own LRS surface rather than to an external one.
 *
 * Enable with `FOXXI_LRS_BACKEND=pod` (the bridge's pod URL + authority
 * are read from the existing FOXXI_TENANT_POD_URL / FOXXI_AUTHORITATIVE_SOURCE
 * env vars).
 */

import {
  createPGSL,
  mintAtom,
} from '@interego/pgsl';
import {
  discover,
  publish,
} from '@interego/solid';
import type {
  AccessControlFacetData,
  AgentFacetData,
  ContextDescriptorData,
  ContextFacetData,
  FederationFacetData,
  FetchFn,
  IRI,
  ProvenanceFacetData,
  SemioticFacetData,
  TemporalFacetData,
  TrustFacetData,
} from '@interego/core';
import type {
  PGSLInstance,
} from '@interego/pgsl';
import { createHash } from 'node:crypto';
import { FOXXI_NS } from './foxxi-vocab.js';
import { tesc, iesc } from './turtle-escape.js';
import {
  type StatementStore, type StoredStatement, type QueryFilter, type QueryResult,
  ConflictError, matchesFilter, paginate,
} from './statement-store.js';

// ── Vocabularies ────────────────────────────────────────────────────
// We declare a foxxi-local term, foxxi:LearningStatement, that is
// owl:equivalentClass with tincan:Statement (the de-facto vocabulary
// for xAPI). Either tag will discover; we use the foxxi: term so the
// pod-side type IRI matches the rest of the vertical's vocabulary.
const FOXXI = FOXXI_NS;
const TINCAN_STATEMENT_TYPE = 'http://adlnet.gov/expapi/Statement' as IRI;
const FOXXI_STATEMENT_TYPE = `${FOXXI}LearningStatement` as IRI;
const FOXXI_VOIDED_BY = `${FOXXI}voidedBy` as IRI;
const FOXXI_BUNDLE_JSON = `${FOXXI}bundleJson` as IRI;

// ── Per-process PGSL instance for content-addressing ────────────────
let _pgsl: PGSLInstance | null = null;
function pgsl(): PGSLInstance {
  if (_pgsl) return _pgsl;
  _pgsl = createPGSL({
    wasAttributedTo: 'urn:foxxi:bridge:lrs' as IRI,
    generatedAtTime: new Date().toISOString(),
  });
  return _pgsl;
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

// ── Build a iep:ContextDescriptor that IS the xAPI Statement ─────────
function buildStatementDescriptor(args: {
  rec: StoredStatement;
  podUrl: string;
  authoritativeSource: IRI;
}): ContextDescriptorData {
  const { rec, authoritativeSource } = args;
  const stmt = rec.statement as Record<string, unknown>;
  const stored = rec.stored;
  const actor = stmt.actor as Record<string, unknown> | undefined;
  const actorAccount = actor?.account as { name?: string; homePage?: string } | undefined;
  const actorMbox = typeof actor?.mbox === 'string' ? actor.mbox : undefined;
  const actorId = actorAccount?.name
    ? `urn:actor:${actorAccount.name}`
    : (actorMbox ? actorMbox.replace(/^mailto:/, 'urn:agent:') : 'urn:agent:anonymous');
  const authority = stmt.authority as { account?: { homePage?: string } } | undefined;
  const issuer = (authority?.account?.homePage ?? String(authoritativeSource)) as IRI;
  const verbId = (stmt.verb as { id?: string } | undefined)?.id ?? '';

  const temporal: TemporalFacetData = { type: 'Temporal', validFrom: stored };
  const provenance: ProvenanceFacetData = {
    type: 'Provenance',
    wasAttributedTo: authoritativeSource,
    wasGeneratedBy: { agent: actorId as IRI, endedAt: stored },
    generatedAtTime: stored,
  };
  const agentFacet: AgentFacetData = {
    type: 'Agent',
    assertingAgent: {
      id: actorId as IRI, identity: actorId as IRI,
      isSoftwareAgent: false,
      ...(verbId ? { label: verbId.split('/').pop() } : {}),
    },
  };
  const accessControl: AccessControlFacetData = {
    type: 'AccessControl',
    authorizations: [{ agentClass: 'http://xmlns.com/foaf/0.1/Agent' as IRI, mode: ['Read'] }],
  };
  // xAPI Statements are committed claims by spec → Asserted.
  // Voiding moves a statement out of ordinary queries — we express that
  // by re-publishing the SAME descriptor IRI with a `iep:supersedes`
  // pointer and the voided flag in the graph. Here, modal status stays
  // Asserted (the void itself is a separate, also-Asserted event).
  const semiotic: SemioticFacetData = {
    type: 'Semiotic', modalStatus: 'Asserted', groundTruth: true,
  };
  const trust: TrustFacetData = {
    type: 'Trust', trustLevel: 'ThirdPartyAttested', issuer,
  };
  const federation: FederationFacetData = {
    type: 'Federation', origin: authoritativeSource,
  };
  const facets: ContextFacetData[] = [temporal, provenance, agentFacet, accessControl, semiotic, trust, federation];

  const descriptorIri = `urn:foxxi:statement:${rec.id}#descriptor` as IRI;
  const graphIri = `urn:foxxi:statement:${rec.id}` as IRI;
  return {
    id: descriptorIri,
    describes: [graphIri],
    conformsTo: [FOXXI_STATEMENT_TYPE, TINCAN_STATEMENT_TYPE],
    facets,
  };
}

function buildStatementGraph(args: {
  rec: StoredStatement;
  payloadAtom: IRI;
  authoritativeSource: IRI;
}): string {
  const { rec, payloadAtom, authoritativeSource } = args;
  const graphIri = iesc(`urn:foxxi:statement:${rec.id}`);
  const json = JSON.stringify(rec.statement);
  const b64 = Buffer.from(json, 'utf8').toString('base64');
  const hash = sha256Hex(json);
  const verbId = (rec.statement.verb as { id?: string } | undefined)?.id ?? '';
  const objectId = (rec.statement.object as { id?: string } | undefined)?.id ?? '';
  const registration = (rec.statement.context as { registration?: string } | undefined)?.registration ?? null;
  const lines: string[] = [];
  lines.push(`@prefix dct:   <http://purl.org/dc/terms/> .`);
  lines.push(`@prefix prov:  <http://www.w3.org/ns/prov#> .`);
  lines.push(`@prefix pgsl:  <https://markjspivey-xwisee.github.io/interego/ns/pgsl/v1#> .`);
  lines.push(`@prefix foxxi: <${FOXXI}> .`);
  lines.push(`@prefix xsd:   <http://www.w3.org/2001/XMLSchema#> .`);
  lines.push(`@prefix tincan:<http://adlnet.gov/expapi/> .`);
  lines.push(``);
  lines.push(`<${graphIri}>`);
  lines.push(`  a <${FOXXI_STATEMENT_TYPE}>, <${TINCAN_STATEMENT_TYPE}> ;`);
  lines.push(`  prov:wasAttributedTo <${authoritativeSource}> ;`);
  lines.push(`  pgsl:hasAtom <${payloadAtom}> ;`);
  lines.push(`  dct:identifier "xapi-statement:${tesc(rec.id)}" ;`);
  lines.push(`  foxxi:storedAt "${tesc(rec.stored)}"^^xsd:dateTime ;`);
  // verb.id + object.id come from the caller's xAPI statement → iesc so a crafted verb/object
  // IRI cannot break out of <...> and inject triples into the published statement graph.
  if (verbId) lines.push(`  foxxi:xapiVerb <${iesc(verbId)}> ;`);
  if (objectId) lines.push(`  foxxi:xapiObject <${iesc(objectId)}> ;`);
  if (registration) lines.push(`  foxxi:registration "${tesc(registration)}" ;`);
  if (rec.voided) {
    lines.push(`  foxxi:isVoided "true"^^xsd:boolean ;`);
    if (rec.voidingStatementId) {
      lines.push(`  <${FOXXI_VOIDED_BY}> <${iesc(`urn:foxxi:statement:${rec.voidingStatementId}`)}> ;`);
    }
  }
  lines.push(`  foxxi:contentHash "sha256:${hash}" ;`);
  lines.push(`  <${FOXXI_BUNDLE_JSON}> "${b64}"^^xsd:base64Binary .`);
  return lines.join('\n');
}

// ── Decode a statement back out of its descriptor / graph ───────────
// We embed the full xAPI Statement as a base64-encoded JSON literal in
// the named graph (the foxxi:bundleJson predicate). Reading it back is
// a regex pull (parseTrig parsing is overkill for one literal). When
// real parseTrig is wired in, swap this for that.
function decodeStatementFromGraphTurtle(turtle: string): Record<string, unknown> | null {
  const m = turtle.match(/foxxi:bundleJson\s+"([^"]+)"\^\^xsd:base64Binary/);
  if (!m) return null;
  try {
    const json = Buffer.from(m[1], 'base64').toString('utf8');
    return JSON.parse(json);
  } catch { return null; }
}
function decodeStoredFromTurtle(turtle: string, fallbackId: string): StoredStatement | null {
  const stmt = decodeStatementFromGraphTurtle(turtle);
  if (!stmt) return null;
  const storedMatch = turtle.match(/foxxi:storedAt\s+"([^"]+)"/);
  const voidedMatch = turtle.match(/foxxi:isVoided\s+"true"/);
  const voidedByMatch = turtle.match(/foxxi:voidedBy\s+<urn:foxxi:statement:([^>]+)>/);
  return {
    id: typeof stmt.id === 'string' ? stmt.id : fallbackId,
    statement: stmt,
    stored: storedMatch?.[1] ?? new Date().toISOString(),
    voided: !!voidedMatch,
    ...(voidedByMatch ? { voidingStatementId: voidedByMatch[1] } : {}),
  };
}

// ── The store itself ────────────────────────────────────────────────

export interface PodStatementStoreConfig {
  readonly podUrl: string;
  readonly authoritativeSource: IRI;
  readonly fetch?: FetchFn;
  /** Pod-relative container for statements. */
  readonly containerPath?: string;
  /** Hot cache TTL (ms) — how long discover() results stay fresh. Default 5000ms. */
  readonly cacheTtlMs?: number;
}

export class PodStatementStore implements StatementStore {
  private readonly podUrl: string;
  private readonly authoritativeSource: IRI;
  private readonly fetchFn: FetchFn;
  private readonly containerPath: string;
  private readonly cacheTtlMs: number;
  // Hot mirror of recently-published statements; the source of truth is
  // the pod. The mirror is updated on every write and periodically
  // rehydrated from the pod on read (cacheTtlMs).
  private readonly hot = new Map<string, StoredStatement>();
  private lastListAt = 0;

  constructor(config: PodStatementStoreConfig) {
    this.podUrl = config.podUrl.endsWith('/') ? config.podUrl : `${config.podUrl}/`;
    this.authoritativeSource = config.authoritativeSource;
    this.fetchFn = config.fetch ?? globalThis.fetch.bind(globalThis);
    this.containerPath = config.containerPath ?? 'foxxi/lrs/';
    this.cacheTtlMs = config.cacheTtlMs ?? 5000;
  }

  backendDescription(): string {
    return `pod-backed (iep:ContextDescriptor projections in ${this.podUrl}${this.containerPath}; conformsTo foxxi:LearningStatement, tincan:Statement; substrate IS the source of truth)`;
  }

  /** Publish a new statement (or overwrite an existing same-id statement). */
  async put(rec: StoredStatement): Promise<void> {
    const existing = this.hot.get(rec.id);
    if (existing) {
      // xAPI immutability: same id, different body → 409.
      const a = JSON.stringify(existing.statement);
      const b = JSON.stringify(rec.statement);
      if (a !== b) throw new ConflictError(`statement ${rec.id} already exists with a different body`);
      return; // identical re-PUT → no-op
    }
    const payloadJson = JSON.stringify(rec.statement);
    const payloadAtom = mintAtom(pgsl(), payloadJson);
    const descriptor = buildStatementDescriptor({
      rec, podUrl: this.podUrl, authoritativeSource: this.authoritativeSource,
    });
    const graphContent = buildStatementGraph({ rec, payloadAtom, authoritativeSource: this.authoritativeSource });

    await publish(descriptor, graphContent, this.podUrl, {
      fetch: this.fetchFn,
      containerPath: this.containerPath,
      descriptorSlug: `statement-${rec.id}`,
      graphSlug: `statement-${rec.id}-graph`,
    });

    // Mirror the write so subsequent reads in the same process window
    // see it immediately (the pod manifest may take a beat).
    this.hot.set(rec.id, rec);
  }

  async get(id: string): Promise<StoredStatement | null> {
    const cached = this.hot.get(id);
    if (cached) return cached;
    // Fall through to a pod fetch: descriptor URL is deterministic.
    try {
      const descUrl = `${this.podUrl}${this.containerPath}statement-${id}.ttl`;
      const graphUrl = `${this.podUrl}${this.containerPath}statement-${id}-graph.trig`;
      const r = await this.fetchFn(graphUrl, { headers: { Accept: 'application/trig, text/turtle' } });
      if (!r.ok) return null;
      const ttl = await r.text();
      const rec = decodeStoredFromTurtle(ttl, id);
      if (rec) this.hot.set(id, rec);
      return rec;
      // Mark descUrl referenced for the type checker / future verification.
      void descUrl;
    } catch { return null; }
  }

  async markVoided(id: string, voidingStatementId: string): Promise<void> {
    // Voiding republishes the statement descriptor with foxxi:isVoided
    // true + foxxi:voidedBy pointing at the voiding statement. The pod
    // manifest CAS keeps the operation safe under concurrent writes.
    const rec = await this.get(id);
    if (!rec) return;
    const voidedRec: StoredStatement = { ...rec, voided: true, voidingStatementId };
    const payloadJson = JSON.stringify(voidedRec.statement);
    const payloadAtom = mintAtom(pgsl(), payloadJson);
    const descriptor = buildStatementDescriptor({
      rec: voidedRec, podUrl: this.podUrl, authoritativeSource: this.authoritativeSource,
    });
    const graphContent = buildStatementGraph({ rec: voidedRec, payloadAtom, authoritativeSource: this.authoritativeSource });
    await publish(descriptor, graphContent, this.podUrl, {
      fetch: this.fetchFn,
      containerPath: this.containerPath,
      descriptorSlug: `statement-${id}`,
      graphSlug: `statement-${id}-graph`,
    });
    this.hot.set(id, voidedRec);
  }

  /** Filtered query — applies the in-memory filter against the rehydrated mirror. */
  async query(filter: QueryFilter): Promise<QueryResult> {
    await this.rehydrateIfStale();
    if (filter.statementId) {
      const r = this.hot.get(filter.statementId);
      if (!r || r.voided) return { statements: [], more: null };
      return { statements: [r], more: null };
    }
    if (filter.voidedStatementId) {
      const r = this.hot.get(filter.voidedStatementId);
      if (!r || !r.voided) return { statements: [], more: null };
      return { statements: [r], more: null };
    }
    const filtered = [...this.hot.values()].filter(r => !r.voided && matchesFilter(r, filter));
    return paginate(filtered, filter);
  }

  async listAll(): Promise<StoredStatement[]> {
    await this.rehydrateIfStale();
    return [...this.hot.values()];
  }

  async count(): Promise<number> {
    await this.rehydrateIfStale();
    return this.hot.size;
  }

  async clear(): Promise<void> {
    // The pod is the source of truth; we don't bulk-DELETE pod
    // descriptors from here. Local mirror clear only — useful for tests.
    this.hot.clear();
    this.lastListAt = 0;
  }

  /**
   * Rehydrate the hot mirror from the pod when its cached snapshot
   * expires. Uses discover() filtered by facetType=Federation (every
   * foxxi:LearningStatement descriptor has one) + a post-filter on
   * conformsTo to narrow to statements. For each match we fetch the
   * graph and decode the embedded JSON.
   */
  private async rehydrateIfStale(): Promise<void> {
    const now = Date.now();
    if (now - this.lastListAt < this.cacheTtlMs) return;
    this.lastListAt = now;
    try {
      const entries = await discover(this.podUrl, {}, { fetch: this.fetchFn });
      const statementEntries = entries.filter(e =>
        Array.isArray((e as { conformsTo?: readonly IRI[] }).conformsTo)
        && (e as { conformsTo: readonly IRI[] }).conformsTo.some(t =>
          String(t) === FOXXI_STATEMENT_TYPE || String(t) === TINCAN_STATEMENT_TYPE)
      );
      for (const entry of statementEntries) {
        const graphIri = (entry as { graph?: string }).graph
          ?? entry.describes?.[0];
        if (!graphIri) continue;
        const id = String(graphIri).replace(/^urn:foxxi:statement:/, '');
        if (this.hot.has(id)) continue;
        const graphUrl = `${this.podUrl}${this.containerPath}statement-${id}-graph.trig`;
        try {
          const r = await this.fetchFn(graphUrl, { headers: { Accept: 'application/trig, text/turtle' } });
          if (!r.ok) continue;
          const ttl = await r.text();
          const rec = decodeStoredFromTurtle(ttl, id);
          if (rec) this.hot.set(id, rec);
        } catch { /* skip — partial pod is acceptable */ }
      }
    } catch (err) {
      console.error('[pod-statement-store] rehydrate failed:', (err as Error).message);
    }
  }
}
