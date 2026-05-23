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
 * pod (cg:supersedes-chained to the previous), and provides a hydrate
 * call the bridge runs at startup to restore the state from the pod.
 *
 * The pod is the durable source of truth across container restarts.
 * In-memory state is the hot cache; it dies with the process but
 * snapshots persist. Each surface's snapshot is one cg:ContextDescriptor
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

import { publish, createPGSL, mintAtom } from '@interego/core';
import type {
  ContextDescriptorData,
  ContextFacetData,
  IRI,
  FetchFn,
  PGSLInstance,
  TemporalFacetData,
  ProvenanceFacetData,
  AgentFacetData,
  AccessControlFacetData,
  SemioticFacetData,
  TrustFacetData,
  FederationFacetData,
} from '@interego/core';
import { createHash } from 'node:crypto';

const FOXXI = 'https://interego-foxxi-bridge.livelysky-8b81abb0.eastus.azurecontainerapps.io/ns/foxxi#';
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
}

const registry = new Map<string, SnapshotRegistration>();

function podConfig(): {
  podUrl: string;
  authoritativeSource: IRI;
  fetch: FetchFn;
} | null {
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
      id: 'urn:foxxi:bridge:snapshot-publisher' as IRI,
      identity: args.authoritativeSource,
      isSoftwareAgent: true,
    },
  };
  const accessControl: AccessControlFacetData = {
    type: 'AccessControl',
    authorizations: [{ agentClass: 'http://xmlns.com/foaf/0.1/Agent' as IRI, mode: ['Read'] }],
  };
  const semiotic: SemioticFacetData = { type: 'Semiotic', modalStatus: 'Asserted', groundTruth: true };
  const trust: TrustFacetData = { type: 'Trust', trustLevel: 'SelfAsserted', issuer: args.authoritativeSource };
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
  version: number;
  previousIri: IRI | null;
}): string {
  const json = JSON.stringify(args.payload);
  const b64 = Buffer.from(json, 'utf8').toString('base64');
  const hash = sha256Hex(json);
  const lines: string[] = [];
  lines.push(`@prefix dct:   <http://purl.org/dc/terms/> .`);
  lines.push(`@prefix prov:  <http://www.w3.org/ns/prov#> .`);
  lines.push(`@prefix pgsl:  <https://markjspivey-xwisee.github.io/interego/ns/pgsl/v1#> .`);
  lines.push(`@prefix cg:    <https://markjspivey-xwisee.github.io/interego/ns/cg#> .`);
  lines.push(`@prefix foxxi: <${FOXXI}> .`);
  lines.push(`@prefix xsd:   <http://www.w3.org/2001/XMLSchema#> .`);
  lines.push(``);
  lines.push(`<${args.graphIri}>`);
  lines.push(`  a <${args.typeIri}> ;`);
  lines.push(`  prov:wasAttributedTo <${args.authoritativeSource}> ;`);
  lines.push(`  pgsl:hasAtom <${args.payloadAtom}> ;`);
  lines.push(`  dct:identifier "sha256:${hash}" ;`);
  lines.push(`  <${FOXXI_VERSION}> "${args.version}"^^xsd:integer ;`);
  if (args.previousIri) lines.push(`  cg:supersedes <${args.previousIri}> ;`);
  lines.push(`  <${FOXXI_BUNDLE_JSON}> "${b64}"^^xsd:base64Binary .`);
  return lines.join('\n');
}

async function doPublish(reg: SnapshotRegistration): Promise<void> {
  const config = podConfig();
  if (!config) return;
  let payload: unknown;
  try { payload = reg.collect(); } catch (err) {
    console.error(`[pod-snapshot/${reg.surface}] collect failed:`, (err as Error).message);
    return;
  }
  // Skip empty payloads. (e.g. surface has no live state yet.)
  if (payload === null || payload === undefined) return;
  const slug = `${reg.surface}-snapshot`;
  const graphIri = `urn:foxxi:${reg.surface}-snapshot:v${reg.version}` as IRI;
  const descriptorIri = `${graphIri}#descriptor` as IRI;
  const payloadJson = JSON.stringify(payload);
  const payloadAtom = mintAtom(pgsl(), payloadJson);
  const descriptor = snapshotDescriptor({
    descriptorIri, graphIri,
    typeIri: reg.typeIri,
    authoritativeSource: config.authoritativeSource,
    previousIri: reg.lastPublishedDescriptorIri,
  });
  const graphContent = snapshotGraph({
    graphIri, typeIri: reg.typeIri, payloadAtom,
    authoritativeSource: config.authoritativeSource,
    payload, version: reg.version,
    previousIri: reg.lastPublishedDescriptorIri,
  });
  try {
    await publish(descriptor, graphContent, config.podUrl, {
      fetch: config.fetch,
      containerPath: 'foxxi/snapshots/',
      descriptorSlug: slug,
      graphSlug: `${slug}-graph`,
    });
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

/**
 * Read the most recent snapshot of a surface back from the pod. Used
 * at bridge startup to hydrate in-memory state. Returns null if no
 * snapshot has ever been published (first run) or if the fetch fails.
 *
 * The descriptor URL is deterministic for the latest version (the
 * publisher always uses the same slug), so a single GET suffices.
 */
export async function loadLatestSnapshot<T>(surface: string): Promise<T | null> {
  const config = podConfig();
  if (!config) return null;
  const graphUrl = `${config.podUrl}foxxi/snapshots/${surface}-snapshot-graph.trig`;
  try {
    const r = await config.fetch(graphUrl, { headers: { Accept: 'application/trig, text/turtle' } });
    if (!r.ok) return null;
    const ttl = await r.text();
    const m = ttl.match(/foxxi:bundleJson\s+"([^"]+)"\^\^xsd:base64Binary/);
    if (!m) return null;
    return JSON.parse(Buffer.from(m[1], 'base64').toString('utf8')) as T;
  } catch (err) {
    console.error(`[pod-snapshot/${surface}] hydrate failed:`, (err as Error).message);
    return null;
  }
}

/** Foxxi-vocab IRIs for the snapshot types. */
export const FOXXI_SNAPSHOT_TYPES = {
  XapiDocs:         `${FOXXI}XapiTenantSnapshot`        as IRI,
  ScormSessions:    `${FOXXI}ScormTenantSnapshot`       as IRI,
  Cmi5Launches:     `${FOXXI}Cmi5TenantSnapshot`        as IRI,
  LtiLineItems:     `${FOXXI}LtiTenantSnapshot`         as IRI,
  OneRoster:        `${FOXXI}OneRosterSnapshot`         as IRI,
  AgentTrajectories:`${FOXXI}AgentTrajectorySnapshot`   as IRI,
  PerformanceProbes:`${FOXXI}PerformanceProbeSnapshot`  as IRI,
  Evaluations:      `${FOXXI}EvaluationSnapshot`        as IRI,
  CalibrationProfile:`${FOXXI}CalibrationProfileSnapshot` as IRI,
} as const;
