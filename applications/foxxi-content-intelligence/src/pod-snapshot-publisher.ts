/**
 * Surface-level pod snapshot publisher.
 *
 * The companion to PodKeyValueStore / PodStatementStore. Some Foxxi
 * bridge surfaces (SCORM SeqSession, cmi5 launch state, LTI line items,
 * OneRoster overlay, agent trajectories, performance probes) have
 * internal state that is read and written by many call sites inside
 * their own modules. Refactoring every call site to await a pod write
 * is a big diff with conformance risk. Instead, each surface registers
 * a "collect snapshot" function and a Foxxi type IRI; this module
 * debounces calls, publishes a versioned snapshot descriptor on the
 * pod (iep:supersedes-chained to the previous), and provides a hydrate
 * call the bridge runs at startup to restore the state from the pod.
 *
 * The pod is the durable source of truth across container restarts.
 * In-memory state is the hot cache; it dies with the process but
 * snapshots persist. Each surface's snapshot is one iep:ContextDescriptor
 * (conformsTo foxxi:<Surface>Snapshot) carrying the full surface state
 * as foxxi:bundleJson — coarse grained at the surface level, which
 * matches how operators inspect the substrate (one descriptor per
 * subsystem, evolution traced via supersedes).
 *
 * Granularity trade-off: this gives whole-surface snapshots rather
 * than one-descriptor-per-record. The xAPI Statement store kept its
 * per-record projection (PodStatementStore) because queries and
 * voiding semantics require it; the LMS surfaces here use snapshots
 * because that's the natural unit of their state.
 */

import {
  withTransientRetry,
} from '@interego/solid';
import {
  createPGSL,
  mintAtom,
} from '@interego/pgsl';
import {
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
import { createHash, randomUUID } from 'node:crypto';
import { parseTrig, readIriValue, readStringValue } from '@interego/core';
import { bridgeDid, signAsBridge, withPublishLock } from './bridge-signer.js';
import { FOXXI_NS } from './foxxi-vocab.js';
import { decodePodBundle } from './pod-kv-store.js';

const FOXXI = FOXXI_NS;
const FOXXI_BUNDLE_JSON = `${FOXXI}bundleJson` as IRI;
const FOXXI_VERSION = `${FOXXI}snapshotVersion` as IRI;

let _pgsl: PGSLInstance | null = null;
function pgsl(): PGSLInstance {
  if (_pgsl) return _pgsl;
  _pgsl = createPGSL({
    wasAttributedTo: 'urn:foxxi:bridge:snapshot-publisher' as IRI,
    generatedAtTime: new Date().toISOString(),
  });
  return _pgsl;
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

interface SnapshotRegistration {
  surface: string;             // e.g. 'scorm', 'cmi5', 'lti'
  typeIri: IRI;                // foxxi:ScormTenantSnapshot, etc.
  collect: () => unknown;      // returns a JSON-serializable snapshot
  debounceMs: number;
  lastPublishedAt: number;
  lastPublishedDescriptorIri: IRI | null;
  scheduled: NodeJS.Timeout | null;
  version: number;
  immutableLatest: boolean;
  latestHead?: SnapshotLatestHead;
  headConflict: boolean;
  publicationTimeoutMs: number;
  config?: SnapshotPodConfig | null;
}

const registry = new Map<string, SnapshotRegistration>();

export interface SnapshotPodConfig {
  podUrl: string;
  authoritativeSource: IRI;
  fetch: typeof globalThis.fetch;
}

function podConfig(): SnapshotPodConfig | null {
  const podUrl = process.env.FOXXI_TENANT_POD_URL;
  const authoritativeSource = process.env.FOXXI_AUTHORITATIVE_SOURCE;
  if (!podUrl || !authoritativeSource) return null;
  return {
    podUrl: podUrl.endsWith('/') ? podUrl : `${podUrl}/`,
    authoritativeSource: authoritativeSource as unknown as IRI,
    fetch: globalThis.fetch.bind(globalThis),
  };
}

function snapshotDescriptor(args: {
  descriptorIri: IRI;
  graphIri: IRI;
  typeIri: IRI;
  authoritativeSource: IRI;
  previousIri: IRI | null;
  signedByBridge: boolean;
}): ContextDescriptorData {
  const now = new Date().toISOString();
  const bridgeId = bridgeDid() as unknown as IRI;
  const temporal: TemporalFacetData = { type: 'Temporal', validFrom: now };
  const provenance: ProvenanceFacetData = {
    type: 'Provenance',
    wasAttributedTo: args.authoritativeSource,
    ...(args.signedByBridge ? { wasGeneratedBy: { agent: bridgeId, endedAt: now } } : {}),
    generatedAtTime: now,
  };
  const agentFacet: AgentFacetData = {
    type: 'Agent',
    assertingAgent: {
      id: args.signedByBridge ? bridgeId : ('urn:foxxi:bridge:snapshot-publisher' as IRI),
      identity: args.signedByBridge ? bridgeId : args.authoritativeSource,
      isSoftwareAgent: true,
      ...(args.signedByBridge ? { label: 'bridge service' } : {}),
    },
  };
  const accessControl: AccessControlFacetData = {
    type: 'AccessControl',
    authorizations: [{ agentClass: 'http://xmlns.com/foaf/0.1/Agent' as IRI, mode: ['Read'] }],
  };
  const semiotic: SemioticFacetData = { type: 'Semiotic', modalStatus: 'Asserted', groundTruth: true };
  // Bridge-signed snapshots claim CryptographicallyVerified — the
  // signature is embedded in the graph (foxxi:agentSignature) and any
  // reader can re-verify with bridgeDid()'s recovered address. Without a
  // bridge key the snapshot downgrades to SelfAsserted.
  const trust: TrustFacetData = {
    type: 'Trust',
    trustLevel: args.signedByBridge ? 'CryptographicallyVerified' : 'SelfAsserted',
    issuer: args.signedByBridge ? bridgeId : args.authoritativeSource,
  };
  const federation: FederationFacetData = { type: 'Federation', origin: args.authoritativeSource };
  const facets: ContextFacetData[] = [temporal, provenance, agentFacet, accessControl, semiotic, trust, federation];
  return {
    id: args.descriptorIri,
    describes: [args.graphIri],
    conformsTo: [args.typeIri],
    facets,
    ...(args.previousIri ? { supersedes: [args.previousIri] } : {}),
  };
}

function snapshotGraph(args: {
  graphIri: IRI;
  typeIri: IRI;
  payloadAtom: IRI;
  authoritativeSource: IRI;
  payload: unknown;
  signedPayloadJson: string;
  version: number;
  previousIri: IRI | null;
  bridgeSignature?: string;
  bridgeDid?: string;
}): string {
  // Atomize + serialize the EXACT signed bytes so the on-pod graph's
  // hash matches what bridgeSignature covers (and so federation readers
  // can re-verify with the same bytes).
  const json = args.signedPayloadJson;
  const b64 = Buffer.from(json, 'utf8').toString('base64');
  const hash = sha256Hex(json);
  const lines: string[] = [];
  lines.push(`@prefix dct:   <http://purl.org/dc/terms/> .`);
  lines.push(`@prefix prov:  <http://www.w3.org/ns/prov#> .`);
  lines.push(`@prefix pgsl:  <https://markjspivey-xwisee.github.io/interego/ns/pgsl#> .`);
  lines.push(`@prefix iep:    <https://markjspivey-xwisee.github.io/interego/ns/iep#> .`);
  lines.push(`@prefix foxxi: <${FOXXI}> .`);
  lines.push(`@prefix xsd:   <http://www.w3.org/2001/XMLSchema#> .`);
  lines.push(``);
  lines.push(`<${args.graphIri}>`);
  lines.push(`  a <${args.typeIri}> ;`);
  lines.push(`  prov:wasAttributedTo <${args.authoritativeSource}> ;`);
  if (args.bridgeDid) lines.push(`  prov:wasGeneratedBy <${args.bridgeDid}> ;`);
  lines.push(`  pgsl:hasAtom <${args.payloadAtom}> ;`);
  lines.push(`  dct:identifier "sha256:${hash}" ;`);
  lines.push(`  <${FOXXI_VERSION}> "${args.version}"^^xsd:integer ;`);
  if (args.previousIri) lines.push(`  iep:supersedes <${args.previousIri}> ;`);
  if (args.bridgeSignature) lines.push(`  foxxi:agentSignature "${args.bridgeSignature}" ;`);
  lines.push(`  <${FOXXI_BUNDLE_JSON}> "${b64}"^^xsd:base64Binary .`);
  return lines.join('\n');
}

async function doPublish(reg: SnapshotRegistration): Promise<void> {
  const config = reg.config === undefined ? podConfig() : reg.config;
  if (!config) return;
  let payload: unknown;
  try { payload = reg.collect(); } catch (err) {
    console.error(`[pod-snapshot/${reg.surface}] collect failed:`, (err as Error).message);
    return;
  }
  // Skip empty payloads. (e.g. surface has no live state yet.)
  if (payload === null || payload === undefined) return;
  if (reg.immutableLatest) {
    try { await publishImmutableLatest(reg, payload, config); }
    catch (err) { console.error(`[pod-snapshot/${reg.surface}] publish failed:`, (err as Error).message); }
    return;
  }
  const slug = `${reg.surface}-snapshot`;
  const graphIri = `urn:foxxi:${reg.surface}-snapshot:v${reg.version}` as IRI;
  const descriptorIri = `${graphIri}#descriptor` as IRI;
  const payloadJson = JSON.stringify(payload);
  const payloadAtom = mintAtom(pgsl(), payloadJson);
  // Sign as the bridge service so the snapshot lands with
  // iep:CryptographicallyVerified trust; failure to sign just degrades to
  // SelfAsserted (a missing FOXXI_BRIDGE_PRIVATE_KEY in dev, for
  // example, shouldn't break the publish path).
  let bridgeSignature: string | undefined;
  try { bridgeSignature = await signAsBridge(payload); }
  catch (err) { console.warn(`[pod-snapshot/${reg.surface}] bridge sign failed:`, (err as Error).message); }
  const descriptor = snapshotDescriptor({
    descriptorIri, graphIri,
    typeIri: reg.typeIri,
    authoritativeSource: config.authoritativeSource,
    previousIri: reg.lastPublishedDescriptorIri,
    signedByBridge: !!bridgeSignature,
  });
  const graphContent = snapshotGraph({
    graphIri, typeIri: reg.typeIri, payloadAtom,
    authoritativeSource: config.authoritativeSource,
    payload, signedPayloadJson: payloadJson, version: reg.version,
    previousIri: reg.lastPublishedDescriptorIri,
    bridgeSignature,
    bridgeDid: bridgeSignature ? bridgeDid() : undefined,
  });
  try {
    await withPublishLock(() => publish(descriptor, graphContent, config.podUrl, {
      fetch: config.fetch,
      containerPath: 'foxxi/snapshots/',
      descriptorSlug: slug,
      graphSlug: `${slug}-graph`,
    }));
    reg.lastPublishedAt = Date.now();
    reg.lastPublishedDescriptorIri = descriptorIri;
    reg.version += 1;
  } catch (err) {
    console.error(`[pod-snapshot/${reg.surface}] publish failed:`, (err as Error).message);
  }
}

/**
 * Register a snapshot collector for a surface. The collector should be
 * fast and pure (just gather current state into a JSON-serializable
 * structure). Re-registering replaces the previous collector — useful
 * for hot-reload during dev.
 */
export function registerSnapshot(args: {
  surface: string;
  typeIri: IRI;
  collect: () => unknown;
  debounceMs?: number;
  /** Opt-in head-CAS and immutable version artifacts; currently used only by the own-LMS gradebook. */
  immutableLatest?: boolean;
  publicationTimeoutMs?: number;
  /** Explicit transport for an isolated consumer; omitted registrations keep the service environment configuration. */
  config?: SnapshotPodConfig | null;
}): void {
  const existing = registry.get(args.surface);
  if (existing && existing.scheduled) clearTimeout(existing.scheduled);
  registry.set(args.surface, {
    surface: args.surface,
    typeIri: args.typeIri,
    collect: args.collect,
    debounceMs: args.debounceMs ?? 2000,
    lastPublishedAt: 0,
    lastPublishedDescriptorIri: existing?.lastPublishedDescriptorIri ?? null,
    scheduled: null,
    version: existing?.version ?? 1,
    immutableLatest: args.immutableLatest ?? false,
    latestHead: existing?.latestHead,
    headConflict: existing?.headConflict ?? false,
    publicationTimeoutMs: Math.max(1, Math.min(args.publicationTimeoutMs ?? 45_000, 45_000)),
    config: args.config,
  });
}

/**
 * Mark a registered surface as dirty. The publisher debounces and
 * publishes a new snapshot when the debounce window expires. Multiple
 * dirty() calls within the window collapse into one publish.
 */
export function dirty(surface: string): void {
  const reg = registry.get(surface);
  if (!reg) return;
  if (reg.scheduled) return; // already scheduled; will publish current state
  reg.scheduled = setTimeout(() => {
    reg.scheduled = null;
    void doPublish(reg);
  }, reg.debounceMs);
}

/**
 * Force-publish every registered surface immediately. Useful for tests
 * and for graceful shutdown.
 */
export async function flushAll(): Promise<void> {
  const promises: Array<Promise<void>> = [];
  for (const reg of registry.values()) {
    if (reg.scheduled) { clearTimeout(reg.scheduled); reg.scheduled = null; }
    promises.push(doPublish(reg));
  }
  await Promise.all(promises);
}

/** Flush one surface without touching another subsystem's registered collectors. */
export async function flushSnapshot(surface: string): Promise<void> {
  const reg = registry.get(surface);
  if (!reg) return;
  if (reg.scheduled) { clearTimeout(reg.scheduled); reg.scheduled = null; }
  await doPublish(reg);
}

/**
 * Read the most recent snapshot of a surface back from the pod. Used
 * at bridge startup to hydrate in-memory state. Returns null if no
 * snapshot has ever been published (first run) or if the fetch fails.
 *
 * The descriptor URL is deterministic for the latest version (the
 * publisher always uses the same slug), so a single GET suffices.
 */
export async function loadLatestSnapshot<T>(surface: string, config: {
  podUrl: string; authoritativeSource: IRI; fetch: FetchFn;
} | null = podConfig()): Promise<T | null> {
  if (!config) return null;
  const graphUrl = `${config.podUrl}foxxi/snapshots/${surface}-snapshot-graph.trig`;
  try {
    const ttl = await withTransientRetry(async () => {
      const r = await config.fetch(graphUrl, { headers: { Accept: 'application/trig, text/turtle' } });
      if (!r.ok) {
        // 404 means no snapshot yet (first run) — surface as a sentinel so
        // the outer caller can return null without retrying.
        if (r.status === 404) return null;
        throw new Error(`snapshot fetch failed: ${r.status} ${r.statusText}`);
      }
      return r.text();
    });
    if (ttl === null) return null;
    return decodePodBundle<T>(ttl);
  } catch (err) {
    console.error(`[pod-snapshot/${surface}] hydrate failed:`, (err as Error).message);
    return null;
  }
}

export interface SnapshotLatestHead {
  etag: string | null;
  descriptorIri: IRI | null;
  payloadDigest: string | null;
}
export type SnapshotUnavailableReason = 'not-configured' | 'transport' | 'http' | 'invalid-snapshot'
  | 'invalid-head' | 'head-unversioned' | 'legacy-head-missing' | 'legacy-head-mismatch';
export type StrictSnapshotResult<T> =
  | { state: 'loaded'; snapshot: T; revision: { sha256: string; etag?: string; version?: number }; head?: SnapshotLatestHead }
  | { state: 'absent'; head?: SnapshotLatestHead }
  | { state: 'unavailable'; reason: SnapshotUnavailableReason; status?: number };

/** Adopt only a head actually observed by the strict descriptor-following read. A failed read
 * never adopts a fresh ETag over stale RAM, including after a conflicting head write.
 */
export function seedLatestSnapshotHead(surface: string, result: StrictSnapshotResult<unknown>): void {
  const reg = registry.get(surface);
  if (!reg?.immutableLatest || reg.headConflict || (result.state !== 'loaded' && result.state !== 'absent') || !result.head) return;
  if (result.state === 'loaded' && (!strongEtag(result.head.etag) || !result.head.descriptorIri || result.head.payloadDigest !== result.revision.sha256)) return;
  if (result.state === 'absent' && (result.head.etag !== null || result.head.descriptorIri !== null || result.head.payloadDigest !== null)) return;
  reg.latestHead = { ...result.head };
  if (result.state === 'loaded' && result.revision.version !== undefined) reg.version = result.revision.version + 1;
}

const IEP = 'https://markjspivey-xwisee.github.io/interego/ns/iep#';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' as IRI;
const DCT = 'http://purl.org/dc/terms/';
const HYDRA = 'http://www.w3.org/ns/hydra/core#';
const DCAT = 'http://www.w3.org/ns/dcat#';
const strongEtag = (value: string | null): value is string => value !== null && /^"[^"\r\n]+"$/.test(value);
const snapshotContainer = (config: SnapshotPodConfig): string => `${config.podUrl.replace(/\/?$/, '/')}foxxi/snapshots/`;

function snapshotHeadLinks(turtle: string, surface: string, config: SnapshotPodConfig, typeIri: IRI): {
  descriptorIri: IRI; graphIri: IRI; graphUrl: string;
} | null {
  const doc = parseTrig(turtle);
  const descriptors = doc.subjects.filter((s) => readIriValue(s, RDF_TYPE) === `${IEP}ContextDescriptor`);
  if (descriptors.length !== 1) return null;
  const descriptor = descriptors[0]!;
  if (typeof descriptor.subject !== 'string' || readIriValue(descriptor, `${DCT}conformsTo` as IRI) !== typeIri) return null;
  const graphIri = readIriValue(descriptor, `${IEP}describes` as IRI);
  const operations = doc.subjects.filter((s) => readIriValue(s, `${IEP}action` as IRI) === `${IEP}canFetchPayload`);
  if (!graphIri || operations.length !== 1) return null;
  const operation = operations[0]!;
  const roots = doc.subjects.filter((s) => typeof s.subject === 'string'
    && (s.subject === '' || s.subject === descriptor.subject || s.subject === `${snapshotContainer(config)}${surface}-snapshot.ttl`));
  const linked = roots.some((root) => [...(root.properties.get(`${IEP}affordance` as IRI) ?? []),
    ...(root.properties.get(`${IEP}hasDistribution` as IRI) ?? [])].some((term) =>
    (term.kind === 'bnode' && typeof operation.subject !== 'string' && term.id === operation.subject.bnode)
    || (term.kind === 'iri' && term.iri === operation.subject)));
  if (!linked) return null;
  const graphUrl = readIriValue(operation, `${HYDRA}target` as IRI);
  if (!graphUrl || graphUrl !== readIriValue(operation, `${DCAT}accessURL` as IRI)
    || readStringValue(operation, `${HYDRA}method` as IRI) !== 'GET'
    || readStringValue(operation, `${DCAT}mediaType` as IRI) !== 'application/trig'
    || readStringValue(operation, `${IEP}encrypted` as IRI) !== 'false') return null;
  const prefix = `${snapshotContainer(config)}${surface}-snapshot-`;
  if (graphUrl !== `${prefix}graph.trig`
    && !(graphUrl.startsWith(prefix) && /^[a-f0-9]{64}-graph\.trig$/.test(graphUrl.slice(prefix.length)))) return null;
  return { descriptorIri: descriptor.subject as IRI, graphIri, graphUrl };
}

function decodeStrictSnapshot<T>(turtle: string, options: {
  typeIri: IRI; validate: (value: unknown) => value is T; graphIri?: IRI; authoritativeSource?: IRI; surface?: string;
}): StrictSnapshotResult<T> {
  try {
    if (Buffer.byteLength(turtle, 'utf8') > 8 * 1024 * 1024) return { state: 'unavailable', reason: 'invalid-snapshot' };
    const candidates = parseTrig(turtle).subjects.filter((s) => readStringValue(s, FOXXI_BUNDLE_JSON) !== undefined);
    if (candidates.length !== 1) return { state: 'unavailable', reason: 'invalid-snapshot' };
    const subject = candidates[0]!;
    if (readIriValue(subject, RDF_TYPE) !== options.typeIri || (options.graphIri && subject.subject !== options.graphIri)
      || (options.authoritativeSource && readIriValue(subject, 'http://www.w3.org/ns/prov#wasAttributedTo' as IRI) !== options.authoritativeSource)) return { state: 'unavailable', reason: 'invalid-snapshot' };
    const encoded = readStringValue(subject, FOXXI_BUNDLE_JSON)!;
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.toString('base64') !== encoded) return { state: 'unavailable', reason: 'invalid-snapshot' };
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (readStringValue(subject, `${DCT}identifier` as IRI) !== `sha256:${sha256}`) return { state: 'unavailable', reason: 'invalid-snapshot' };
    if (options.graphIri && options.surface) {
      const prefix = `urn:foxxi:${options.surface}-snapshot:`;
      if (!options.graphIri.startsWith(prefix)) return { state: 'unavailable', reason: 'invalid-snapshot' };
      const suffix = options.graphIri.slice(prefix.length);
      if (suffix !== `sha256:${sha256}` && !/^v[1-9]\d*$/.test(suffix)) return { state: 'unavailable', reason: 'invalid-snapshot' };
    }
    const snapshot: unknown = JSON.parse(bytes.toString('utf8'));
    if (!options.validate(snapshot)) return { state: 'unavailable', reason: 'invalid-snapshot' };
    const text = readStringValue(subject, FOXXI_VERSION);
    const version = text && /^[1-9]\d*$/.test(text) ? Number(text) : undefined;
    return { state: 'loaded', snapshot, revision: { sha256, ...(Number.isSafeInteger(version) ? { version } : {}) } };
  } catch { return { state: 'unavailable', reason: 'invalid-snapshot' }; }
}

async function publishImmutableLatest(reg: SnapshotRegistration, payload: unknown, config: SnapshotPodConfig): Promise<void> {
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bounded: SnapshotPodConfig = { ...config, fetch: async (url, init) => {
    abort.signal.throwIfAborted();
    const response = await config.fetch(url, { ...init, signal: abort.signal });
    abort.signal.throwIfAborted();
    return response;
  } };
  try {
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { abort.abort(); reject(new Error('lti_snapshot_publish_deadline')); }, reg.publicationTimeoutMs);
    });
    const queued = withPublishLock(() => {
      abort.signal.throwIfAborted();
      // Bound both time waiting for the shared lock and time holding it. An ignored abort
      // cannot retain the lock or let a late continuation commit a pointer.
      return Promise.race([publishImmutableLatestWork(reg, payload, bounded, abort.signal), deadline]);
    });
    await Promise.race([queued, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
    abort.abort();
  }
}

async function publishImmutableLatestWork(reg: SnapshotRegistration, payload: unknown, config: SnapshotPodConfig, signal: AbortSignal): Promise<void> {
  const head = reg.latestHead;
  if (reg.headConflict) throw new Error('lti_snapshot_head_conflict');
  if (!head) throw new Error('lti_snapshot_head_unobserved');
  const payloadJson = JSON.stringify(payload);
  const payloadDigest = sha256Hex(payloadJson);
  if (payloadDigest === head.payloadDigest) return;
  const container = snapshotContainer(config);
  const slug = `${reg.surface}-snapshot`;
  const descriptorSlug = `${slug}-${randomUUID()}`;
  const descriptorIri = `${container}${descriptorSlug}.ttl` as IRI;
  const graphIri = `urn:foxxi:${slug}:sha256:${payloadDigest}` as IRI;
  const signature = await signAsBridge(payload);
  const graphContent = snapshotGraph({ graphIri, typeIri: reg.typeIri, payloadAtom: mintAtom(pgsl(), payloadJson),
    authoritativeSource: config.authoritativeSource, payload, signedPayloadJson: payloadJson,
    version: reg.version, previousIri: head.descriptorIri, bridgeSignature: signature, bridgeDid: bridgeDid() });
  // Address the immutable logical graph bytes; publish wraps them with descriptor metadata.
  const graphSlug = `${slug}-${sha256Hex(graphContent)}-graph`;
  const descriptor = snapshotDescriptor({ descriptorIri, graphIri, typeIri: reg.typeIri,
    authoritativeSource: config.authoritativeSource, previousIri: head.descriptorIri, signedByBridge: true });
  let published: Awaited<ReturnType<typeof publish>>;
  try {
    published = await publish(descriptor, graphContent, config.podUrl, {
      containerPath: 'foxxi/snapshots/', descriptorSlug, graphSlug,
      fetch: async (url, init) => config.fetch(url, { ...init,
        headers: { ...init?.headers, ...(url === descriptorIri && init?.method === 'PUT' ? { 'If-None-Match': '*' } : {}) } }),
    });
  } catch { throw new Error('lti_snapshot_artifact_publish_unconfirmed'); }
  const get = (url: string) => config.fetch(url, { headers: { Accept: 'application/trig, text/turtle', 'Cache-Control': 'no-cache' }, cache: 'no-store', redirect: 'manual' });
  const storedDescriptor = await get(published.descriptorUrl);
  if (!storedDescriptor.ok) throw new Error('lti_snapshot_artifact_readback_unconfirmed');
  const descriptorBody = await storedDescriptor.text();
  const links = snapshotHeadLinks(descriptorBody, reg.surface, config, reg.typeIri);
  if (!links || links.descriptorIri !== descriptorIri || links.graphIri !== graphIri || links.graphUrl !== published.graphUrl) throw new Error('lti_snapshot_artifact_readback_mismatch');
  const storedGraph = await get(links.graphUrl);
  if (!storedGraph.ok) throw new Error('lti_snapshot_artifact_readback_unconfirmed');
  const decoded = decodeStrictSnapshot(await storedGraph.text(), { typeIri: reg.typeIri, validate: (_): _ is unknown => true, graphIri, authoritativeSource: config.authoritativeSource, surface: reg.surface });
  if (decoded.state !== 'loaded' || decoded.revision.sha256 !== payloadDigest) throw new Error('lti_snapshot_artifact_readback_mismatch');
  const latestUrl = `${container}${slug}.ttl`;
  const committed = await config.fetch(latestUrl, { method: 'PUT', redirect: 'manual', headers: {
    'Content-Type': 'text/turtle', ...(head.etag === null ? { 'If-None-Match': '*' } : { 'If-Match': head.etag }),
  }, body: descriptorBody });
  if (committed.status === 412) { reg.headConflict = true; throw new Error('lti_snapshot_head_conflict'); }
  if (!committed.ok) throw new Error('lti_snapshot_head_commit_unconfirmed');
  const readback = await get(latestUrl);
  if (!readback.ok || !strongEtag(readback.headers.get('etag')) || await readback.text() !== descriptorBody) throw new Error('lti_snapshot_head_readback_unconfirmed');
  signal.throwIfAborted();
  reg.latestHead = { etag: readback.headers.get('etag'), descriptorIri, payloadDigest };
  reg.lastPublishedAt = Date.now();
  reg.lastPublishedDescriptorIri = descriptorIri;
  reg.version += 1;
}

/** Opt-in read for state that must never mistake a failed read for an empty store.
 * A digest witnesses the exact bundle bytes, not a monotonic revision or signature verification.
 * The existing nullable loader remains unchanged for its other callers.
 */
export async function loadLatestSnapshotStrict<T>(surface: string, options: {
  config?: SnapshotPodConfig | null;
  typeIri: IRI;
  validate: (value: unknown) => value is T;
  timeoutMs?: number;
  followLatestDescriptor?: boolean;
}): Promise<StrictSnapshotResult<T>> {
  const config = options.config === undefined ? podConfig() : options.config;
  if (!config) return { state: 'unavailable', reason: 'not-configured' };
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const read = async (): Promise<StrictSnapshotResult<T>> => {
      const get = (url: string) => config.fetch(url, {
        headers: { Accept: 'application/trig, text/turtle', 'Cache-Control': 'no-cache' },
        cache: 'no-store', redirect: 'manual', signal: abort.signal,
      });
      const legacyGraphUrl = `${snapshotContainer(config)}${surface}-snapshot-graph.trig`;
      let graphUrl = legacyGraphUrl;
      let links: ReturnType<typeof snapshotHeadLinks> = null;
      let headEtag: string | null = null;
      if (options.followLatestDescriptor) {
        const head = await get(`${snapshotContainer(config)}${surface}-snapshot.ttl`);
        if (head.status === 404) {
          const orphan = await get(legacyGraphUrl);
          if (orphan.status === 404) return { state: 'absent', head: { etag: null, descriptorIri: null, payloadDigest: null } };
          if (!orphan.ok) return { state: 'unavailable', reason: 'http', status: orphan.status };
          return { state: 'unavailable', reason: 'legacy-head-missing' };
        }
        if (!head.ok) return { state: 'unavailable', reason: 'http', status: head.status };
        headEtag = head.headers.get('etag');
        if (!strongEtag(headEtag)) return { state: 'unavailable', reason: 'head-unversioned' };
        const body = await head.text();
        if (Buffer.byteLength(body, 'utf8') > 1024 * 1024) return { state: 'unavailable', reason: 'invalid-head' };
        try { links = snapshotHeadLinks(body, surface, config, options.typeIri); }
        catch { return { state: 'unavailable', reason: 'invalid-head' }; }
        if (!links) return { state: 'unavailable', reason: 'invalid-head' };
        graphUrl = links.graphUrl;
      }
      const response = await get(graphUrl);
      if (options.followLatestDescriptor && !response.ok) return { state: 'unavailable', reason: 'http', status: response.status };
      if (response.status === 404) return { state: 'absent' };
      if (!response.ok) return { state: 'unavailable', reason: 'http', status: response.status };
      const turtle = await response.text();
      const decoded = decodeStrictSnapshot(turtle, { ...options, ...(links ? { graphIri: links.graphIri, authoritativeSource: config.authoritativeSource, surface } : {}) });
      if (decoded.state !== 'loaded') return links && graphUrl === legacyGraphUrl ? { state: 'unavailable', reason: 'legacy-head-mismatch' } : decoded;
      return { ...decoded, revision: { ...decoded.revision, ...(response.headers.get('etag') ? { etag: response.headers.get('etag')! } : {}) },
        ...(links ? { head: { etag: headEtag, descriptorIri: links.descriptorIri, payloadDigest: decoded.revision.sha256 } } : {}) };
    };
    return await Promise.race([read(), new Promise<StrictSnapshotResult<T>>((resolve) => {
      timer = setTimeout(() => { abort.abort(); resolve({ state: 'unavailable', reason: 'transport' }); }, options.timeoutMs ?? 8000);
    })]);
  } catch {
    return { state: 'unavailable', reason: 'transport' };
  } finally {
    if (timer) clearTimeout(timer);
    abort.abort();
  }
}

/** Foxxi-vocab IRIs for the snapshot types. */
export const FOXXI_SNAPSHOT_TYPES = {
  XapiDocs:         `${FOXXI}XapiTenantSnapshot`        as IRI,
  ScormSessions:    `${FOXXI}ScormTenantSnapshot`       as IRI,
  Cmi5Launches:     `${FOXXI}Cmi5TenantSnapshot`        as IRI,
  LtiLineItems:     `${FOXXI}LtiTenantSnapshot`         as IRI,
  LtiPlatformGradebook: `${FOXXI}LtiPlatformSnapshot` as IRI,
  OneRoster:        `${FOXXI}OneRosterSnapshot`         as IRI,
  AgentTrajectories:`${FOXXI}AgentTrajectorySnapshot`   as IRI,
  PerformanceProbes:`${FOXXI}PerformanceProbeSnapshot`  as IRI,
  Evaluations:      `${FOXXI}EvaluationSnapshot`        as IRI,
  CalibrationProfile:`${FOXXI}CalibrationProfileSnapshot` as IRI,
} as const;
