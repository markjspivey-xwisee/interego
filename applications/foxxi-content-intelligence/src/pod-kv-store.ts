/**
 * Generic pod-backed key-value projection.
 *
 * `PodKeyValueStore<T>` is the reusable primitive that every "parallel
 * to Interego" in-memory store gets refactored into. From the outside
 * it's `put(key, value) / get(key) / list() / delete(key)` — exactly
 * what the existing in-memory Maps offered. From the inside every
 * write becomes a real iep:ContextDescriptor on the tenant pod:
 *
 *    put(key, value)
 *       ↓
 *    mint pgsl:Atom for the payload
 *       ↓
 *    build iep:ContextDescriptor (typed conformsTo `${typeIri}`, all
 *    seven facets)
 *       ↓
 *    publish(descriptor, graph, pod)  — TriG named graph carries the
 *    full payload as foxxi:bundleJson + pgsl:hasAtom link
 *
 * Updates to the same key re-publish at the same slug (descriptor file
 * is overwritten with HTTP If-Match CAS; manifest stays consistent).
 * "Deletes" publish a tombstone descriptor with foxxi:isDeleted + a
 * iep:supersedes link to the previous version — the substrate keeps a
 * complete history. Reads land on a hot mirror that rehydrates from
 * the pod on a TTL.
 *
 * Every LMS surface (SCORM session, cmi5 launch, LTI line item,
 * OneRoster overlay, xAPI state/profile docs, ...) is a thin typed
 * wrapper around this primitive. The xAPI Statement store predates
 * this and keeps its own dedicated module because it has voiding
 * semantics; everything else uses PodKeyValueStore directly.
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

const FOXXI = FOXXI_NS;
const FOXXI_BUNDLE_JSON = `${FOXXI}bundleJson` as IRI;
const FOXXI_IS_DELETED = `${FOXXI}isDeleted` as IRI;
const FOXXI_SUPERSEDED_AT = `${FOXXI}supersededAt` as IRI;

let _pgsl: PGSLInstance | null = null;
function pgsl(): PGSLInstance {
  if (_pgsl) return _pgsl;
  _pgsl = createPGSL({
    wasAttributedTo: 'urn:foxxi:bridge:pod-kv-store' as IRI,
    generatedAtTime: new Date().toISOString(),
  });
  return _pgsl;
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/** Slugify an arbitrary key into a filesystem-safe identifier. */
export function keyToSlug(key: string): string {
  // Hash long or unsafe keys to keep filenames sane and deterministic.
  // Short alphanumeric keys pass through unchanged (readable on the pod).
  if (/^[a-zA-Z0-9._-]{1,80}$/.test(key)) return key.toLowerCase();
  return sha256Hex(key).slice(0, 40);
}

export interface PodKvConfig {
  /** Tenant pod root (e.g. https://interego-css..../foxxi/). Must end with /. */
  readonly podUrl: string;
  /** did:web of the authoritative source for the tenant. */
  readonly authoritativeSource: IRI;
  /** Foxxi type IRI this store's descriptors conform to (e.g. foxxi:ScormSession). */
  readonly typeIri: IRI;
  /** Pod-relative container path (e.g. 'foxxi/scorm/sessions/'). */
  readonly containerPath: string;
  /** Stable URN prefix for the entity IRIs (e.g. 'urn:foxxi:scorm-session:'). */
  readonly iriPrefix: string;
  /** Optional authenticated fetch. */
  readonly fetch?: FetchFn;
  /** Pod read cache TTL (ms). Default 5000. */
  readonly cacheTtlMs?: number;
}

function buildDescriptor(args: {
  descriptorIri: IRI;
  entityIri: IRI;
  typeIri: IRI;
  authoritativeSource: IRI;
  supersedes?: IRI;
  modalStatus: 'Asserted' | 'Hypothetical' | 'Counterfactual';
}): ContextDescriptorData {
  const now = new Date().toISOString();
  const temporal: TemporalFacetData = { type: 'Temporal', validFrom: now };
  const provenance: ProvenanceFacetData = {
    type: 'Provenance',
    wasAttributedTo: args.authoritativeSource,
    generatedAtTime: now,
  };
  const agentFacet: AgentFacetData = {
    type: 'Agent',
    assertingAgent: {
      id: 'urn:foxxi:bridge:service' as IRI,
      identity: args.authoritativeSource,
      isSoftwareAgent: true,
    },
  };
  const accessControl: AccessControlFacetData = {
    type: 'AccessControl',
    authorizations: [{ agentClass: 'http://xmlns.com/foaf/0.1/Agent' as IRI, mode: ['Read'] }],
  };
  const semiotic: SemioticFacetData = {
    type: 'Semiotic', modalStatus: args.modalStatus,
    ...(args.modalStatus === 'Asserted' ? { groundTruth: true as const } : {}),
  };
  const trust: TrustFacetData = {
    type: 'Trust', trustLevel: 'SelfAsserted',
    issuer: args.authoritativeSource,
  };
  const federation: FederationFacetData = {
    type: 'Federation', origin: args.authoritativeSource,
  };
  const facets: ContextFacetData[] = [temporal, provenance, agentFacet, accessControl, semiotic, trust, federation];
  return {
    id: args.descriptorIri,
    describes: [args.entityIri],
    conformsTo: [args.typeIri],
    facets,
    ...(args.supersedes ? { supersedes: [args.supersedes] } : {}),
  };
}

function buildGraph(args: {
  entityIri: IRI;
  typeIri: IRI;
  payloadAtom: IRI;
  authoritativeSource: IRI;
  payload: unknown;
  isDeleted?: boolean;
  supersedes?: IRI;
}): string {
  const json = JSON.stringify(args.payload);
  const b64 = Buffer.from(json, 'utf8').toString('base64');
  const hash = sha256Hex(json);
  const lines: string[] = [];
  lines.push(`@prefix dct:   <http://purl.org/dc/terms/> .`);
  lines.push(`@prefix prov:  <http://www.w3.org/ns/prov#> .`);
  lines.push(`@prefix pgsl:  <https://markjspivey-xwisee.github.io/interego/ns/pgsl/v1#> .`);
  lines.push(`@prefix iep:    <https://markjspivey-xwisee.github.io/interego/ns/iep#> .`);
  lines.push(`@prefix foxxi: <${FOXXI}> .`);
  lines.push(`@prefix xsd:   <http://www.w3.org/2001/XMLSchema#> .`);
  lines.push(``);
  lines.push(`<${args.entityIri}>`);
  lines.push(`  a <${args.typeIri}> ;`);
  lines.push(`  prov:wasAttributedTo <${args.authoritativeSource}> ;`);
  lines.push(`  pgsl:hasAtom <${args.payloadAtom}> ;`);
  lines.push(`  dct:identifier "sha256:${hash}" ;`);
  if (args.supersedes) lines.push(`  iep:supersedes <${args.supersedes}> ;`);
  if (args.isDeleted) lines.push(`  <${FOXXI_IS_DELETED}> "true"^^xsd:boolean ;`);
  lines.push(`  <${FOXXI_BUNDLE_JSON}> "${b64}"^^xsd:base64Binary .`);
  return lines.join('\n');
}

function decodeFromGraphTurtle<T>(turtle: string): T | null {
  const m = turtle.match(/foxxi:bundleJson\s+"([^"]+)"\^\^xsd:base64Binary/);
  if (!m) return null;
  try { return JSON.parse(Buffer.from(m[1], 'base64').toString('utf8')) as T; }
  catch { return null; }
}

function isTombstoned(turtle: string): boolean {
  return /foxxi:isDeleted\s+"true"/.test(turtle);
}

/**
 * Pod-backed key-value store. Each key becomes a typed
 * iep:ContextDescriptor on the pod; updates re-publish at the same
 * slug (HTTP If-Match CAS keeps the manifest consistent); deletes
 * publish a tombstone with `foxxi:isDeleted` and a `iep:supersedes`
 * pointer to the previous descriptor version.
 *
 * Reads land on a hot in-process mirror; the mirror rehydrates from
 * the pod when its TTL expires. The pod is the source of truth across
 * container restarts.
 */
export class PodKeyValueStore<T extends object> {
  private readonly podUrl: string;
  private readonly containerPath: string;
  private readonly iriPrefix: string;
  private readonly typeIri: IRI;
  private readonly authoritativeSource: IRI;
  private readonly fetchFn: FetchFn;
  private readonly cacheTtlMs: number;
  private readonly hot = new Map<string, T>();
  private readonly seenTombstones = new Set<string>();
  private lastListAt = 0;

  constructor(config: PodKvConfig) {
    this.podUrl = config.podUrl.endsWith('/') ? config.podUrl : `${config.podUrl}/`;
    this.containerPath = config.containerPath.endsWith('/') ? config.containerPath : `${config.containerPath}/`;
    this.iriPrefix = config.iriPrefix.endsWith(':') ? config.iriPrefix : `${config.iriPrefix}:`;
    this.typeIri = config.typeIri;
    this.authoritativeSource = config.authoritativeSource;
    this.fetchFn = config.fetch ?? globalThis.fetch.bind(globalThis);
    this.cacheTtlMs = config.cacheTtlMs ?? 5000;
  }

  private slugFor(key: string): string { return keyToSlug(key); }
  private entityIri(key: string): IRI { return `${this.iriPrefix}${this.slugFor(key)}` as IRI; }
  private descriptorIri(key: string): IRI { return `${this.entityIri(key)}#descriptor` as IRI; }
  private descriptorUrl(key: string): string { return `${this.podUrl}${this.containerPath}${this.slugFor(key)}.ttl`; }
  private graphUrl(key: string): string { return `${this.podUrl}${this.containerPath}${this.slugFor(key)}-graph.trig`; }

  /** Put (insert OR overwrite) a value at `key`. Returns the descriptor + graph URLs. */
  async put(key: string, value: T): Promise<{ descriptorUrl: string; graphUrl: string; payloadAtom: IRI }> {
    const slug = this.slugFor(key);
    const previous = await this.getRaw(key); // may be null
    const payloadJson = JSON.stringify(value);
    const payloadAtom = mintAtom(pgsl(), payloadJson);
    const entityIri = this.entityIri(key);
    const descriptorIri = this.descriptorIri(key);
    const descriptor = buildDescriptor({
      descriptorIri, entityIri, typeIri: this.typeIri,
      authoritativeSource: this.authoritativeSource,
      modalStatus: 'Asserted',
      ...(previous ? { supersedes: descriptorIri } : {}),
    });
    const graphContent = buildGraph({
      entityIri, typeIri: this.typeIri, payloadAtom,
      authoritativeSource: this.authoritativeSource,
      payload: value,
      ...(previous ? { supersedes: descriptorIri } : {}),
    });
    const res = await publish(descriptor, graphContent, this.podUrl, {
      fetch: this.fetchFn,
      containerPath: this.containerPath,
      descriptorSlug: slug,
      graphSlug: `${slug}-graph`,
    });
    this.hot.set(key, value);
    this.seenTombstones.delete(key);
    return { descriptorUrl: res.descriptorUrl, graphUrl: res.graphUrl, payloadAtom };
  }

  /** Get the value at `key`, or null if missing/tombstoned. */
  async get(key: string): Promise<T | null> {
    if (this.seenTombstones.has(key)) return null;
    const cached = this.hot.get(key);
    if (cached !== undefined) return cached;
    return await this.getRaw(key);
  }

  private async getRaw(key: string): Promise<T | null> {
    try {
      const r = await this.fetchFn(this.graphUrl(key), { headers: { Accept: 'application/trig, text/turtle' } });
      if (!r.ok) return null;
      const ttl = await r.text();
      if (isTombstoned(ttl)) { this.seenTombstones.add(key); return null; }
      const value = decodeFromGraphTurtle<T>(ttl);
      if (value) this.hot.set(key, value);
      return value;
    } catch { return null; }
  }

  /** Delete (tombstone) the value at `key`. */
  async delete(key: string): Promise<void> {
    const slug = this.slugFor(key);
    const entityIri = this.entityIri(key);
    const descriptorIri = this.descriptorIri(key);
    const tombstone = { __deleted: true, supersededAt: new Date().toISOString() };
    const payloadJson = JSON.stringify(tombstone);
    const payloadAtom = mintAtom(pgsl(), payloadJson);
    const descriptor = buildDescriptor({
      descriptorIri, entityIri, typeIri: this.typeIri,
      authoritativeSource: this.authoritativeSource,
      modalStatus: 'Counterfactual',
      supersedes: descriptorIri,
    });
    const graphContent = buildGraph({
      entityIri, typeIri: this.typeIri, payloadAtom,
      authoritativeSource: this.authoritativeSource,
      payload: tombstone, isDeleted: true,
      supersedes: descriptorIri,
    });
    await publish(descriptor, graphContent, this.podUrl, {
      fetch: this.fetchFn,
      containerPath: this.containerPath,
      descriptorSlug: slug,
      graphSlug: `${slug}-graph`,
    });
    this.hot.delete(key);
    this.seenTombstones.add(key);
  }

  /** Iterate all live entries. Rehydrates from the pod when the TTL expires. */
  async list(): Promise<Array<{ key: string; value: T }>> {
    await this.rehydrateIfStale();
    const out: Array<{ key: string; value: T }> = [];
    for (const [k, v] of this.hot) {
      if (!this.seenTombstones.has(k)) out.push({ key: k, value: v });
    }
    return out;
  }

  /** Number of live entries (after rehydration). */
  async size(): Promise<number> {
    await this.rehydrateIfStale();
    let n = 0;
    for (const k of this.hot.keys()) if (!this.seenTombstones.has(k)) n++;
    return n;
  }

  /** Clear the local mirror (does NOT delete pod descriptors). */
  async clearLocal(): Promise<void> {
    this.hot.clear();
    this.seenTombstones.clear();
    this.lastListAt = 0;
  }

  /** Rehydrate the hot mirror from the pod when the TTL expires. */
  private async rehydrateIfStale(): Promise<void> {
    const now = Date.now();
    if (now - this.lastListAt < this.cacheTtlMs) return;
    this.lastListAt = now;
    try {
      const entries = await discover(this.podUrl, {}, { fetch: this.fetchFn });
      const typed = entries.filter(e => {
        const ct = (e as { conformsTo?: readonly IRI[] }).conformsTo;
        return Array.isArray(ct) && ct.some(t => String(t) === String(this.typeIri));
      });
      for (const entry of typed) {
        const graphIri = (entry as { graph?: string }).graph
          ?? entry.describes?.[0];
        if (!graphIri) continue;
        const key = String(graphIri).startsWith(this.iriPrefix)
          ? String(graphIri).slice(this.iriPrefix.length)
          : null;
        if (!key) continue;
        if (this.hot.has(key) || this.seenTombstones.has(key)) continue;
        try {
          const r = await this.fetchFn(this.graphUrl(key), { headers: { Accept: 'application/trig, text/turtle' } });
          if (!r.ok) continue;
          const ttl = await r.text();
          if (isTombstoned(ttl)) { this.seenTombstones.add(key); continue; }
          const value = decodeFromGraphTurtle<T>(ttl);
          if (value) this.hot.set(key, value);
        } catch { /* skip — partial pod is acceptable */ }
      }
    } catch (err) {
      console.error('[pod-kv-store] rehydrate failed:', (err as Error).message);
    }
  }
}

/**
 * Convenience factory: open a PodKeyValueStore from env-vars + minimal
 * per-surface config. The bridge calls this once per surface at startup.
 *
 *    const sessions = openPodKvStore<SeqSession>({
 *      typeIri: 'https://.../foxxi#ScormSession' as IRI,
 *      containerPath: 'foxxi/scorm/sessions/',
 *      iriPrefix: 'urn:foxxi:scorm-session:',
 *    });
 *
 * Falls back to an in-memory Map when FOXXI_TENANT_POD_URL is not set,
 * so the bridge keeps working in dev / unit-test contexts.
 */
export function openPodKvStore<T extends object>(args: {
  typeIri: IRI;
  containerPath: string;
  iriPrefix: string;
}): PodKeyValueStore<T> | Map<string, T> {
  const podUrl = process.env.FOXXI_TENANT_POD_URL;
  const authoritativeSource = process.env.FOXXI_AUTHORITATIVE_SOURCE;
  if (!podUrl || !authoritativeSource) return new Map<string, T>();
  return new PodKeyValueStore<T>({
    podUrl,
    authoritativeSource: authoritativeSource as unknown as IRI,
    typeIri: args.typeIri,
    containerPath: args.containerPath,
    iriPrefix: args.iriPrefix,
  });
}

/** Foxxi-vocab IRIs for every typed projection — single source of truth. */
export const FOXXI_KV_TYPES = {
  ActivityState:        `${FOXXI}ActivityState`        as IRI,
  AgentProfile:         `${FOXXI}AgentProfile`         as IRI,
  ActivityProfile:      `${FOXXI}ActivityProfile`      as IRI,
  ScormSession:         `${FOXXI}ScormSession`         as IRI,
  Cmi5Launch:           `${FOXXI}Cmi5Launch`           as IRI,
  AuSatisfaction:       `${FOXXI}AuSatisfaction`       as IRI,
  LtiLineItem:          `${FOXXI}LtiLineItem`          as IRI,
  OneRosterImport:      `${FOXXI}OneRosterImport`      as IRI,
  AgentTrajectory:      `${FOXXI}AgentTrajectory`      as IRI,
  PerformanceProbe:     `${FOXXI}PerformanceProbe`     as IRI,
  EvaluationRecord:     `${FOXXI}EvaluationRecord`     as IRI,
  CalibrationProfile:   `${FOXXI}CalibrationProfile`   as IRI,
  ParticipationClaim:   `${FOXXI}ParticipationClaim`   as IRI,
} as const;
