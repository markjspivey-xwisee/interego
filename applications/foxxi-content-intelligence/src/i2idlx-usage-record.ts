/** Derived, private usage evidence. Never mutates an xAPI envelope or infers achievement. */
import { createHash } from 'node:crypto';
import { DataFactory, Writer } from 'n3';

type Row = Record<string, unknown>;
export interface KnownUsageConcept { id: string; iri: string; label: string; origin: Row }
export interface UsageContext {
  ns: string;
  agentDid: string;
  concepts: ReadonlyMap<string, KnownUsageConcept>;
  generatedAt: string;
}
export interface UsageRecord {
  typeIri: string;
  recordIri: string;
  sourceStatementIri: string;
  sourceStatementId: string;
  sourceTimestamp: string;
  sourceStored: string;
  generatedAt: string;
  concepts: KnownUsageConcept[];
  unrecognizedTags: string[];
  graph_content: string;
  graphSha256: string;
  inference: 'usage-only; no achievement or competency assertion';
}
export interface PersistedUsageReceipt {
  status: 'persisted' | 'failed' | 'skipped';
  originalRetained: boolean;
  recordIri?: string;
  conceptIris?: string[];
  unrecognizedTags?: string[];
  graphSha256?: string;
  readback?: { method: 'POST'; href: string; uri: string };
  reason?: string;
  holonUri?: string;
}
export interface UsageArtifactReceipt {
  persisted: boolean;
  holonUri?: string;
  descriptorUrl?: string;
  usageRecord?: PersistedUsageReceipt;
}
const CONCEPT_IDS = 'https://foxxi-bridge.interego.xwisee.com/ns/foxxi#conceptIds';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const PROV = 'http://www.w3.org/ns/prov#';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const XAPI = 'https://foxxi-bridge.interego.xwisee.com/ns/xapi#';
const IE = 'https://markjspivey-xwisee.github.io/interego/ns/interego#';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const row = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const text = (value: unknown): string => typeof value === 'string' ? value : '';
function iri(value: string): string {
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:[^\s<>"{}\\]*$/.test(value)) throw new Error('Invalid usage evidence IRI');
  return value;
}
function instant(value: unknown): string {
  const time = typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(time)) throw new Error('Usage evidence requires the actual statement timestamps');
  return new Date(time).toISOString();
}
export function usageTags(statement: Row): string[] {
  const tags = row(row(statement.context).extensions)[CONCEPT_IDS];
  return Array.isArray(tags) ? [...new Set(tags.filter((tag): tag is string => typeof tag === 'string'))].sort() : [];
}

/** Pure deterministic RDF projection over an actual LRS-enriched statement and trusted corpus. */
export function projectUsageRecord(statement: Row, context: UsageContext): UsageRecord | null {
  const tags = usageTags(statement);
  const concepts = tags.flatMap(tag => { const known = context.concepts.get(tag); return known && known.iri === tag ? [known] : []; });
  if (!concepts.length) return null;
  const id = text(statement.id);
  if (!UUID.test(id)) throw new Error('Usage evidence requires the actual xAPI UUID');
  // The observed event, the LRS commit and this derived record's generation are
  // different instants. The caller supplies the real projection time; no event is minted.
  const timestamp = instant(statement.timestamp), stored = instant(statement.stored), generatedAt = instant(context.generatedAt);
  const ns = iri(context.ns), agent = iri(context.agentDid);
  const sourceStatementIri = 'urn:uuid:' + id;
  // Stable across retries and independent of projection time; no replacement event is minted.
  const recordIri = 'urn:i2idlx:usage:' + createHash('sha256').update(ns + '\n' + id).digest('hex');
  const { namedNode: n, literal: l, quad: q } = DataFactory;
  const subject = n(recordIri), source = n(sourceStatementIri);
  const quads = [
    q(subject, n(RDF + 'type'), n(ns + 'UsageRecord')),
    q(subject, n(ns + 'statement'), source),
    q(subject, n(ns + 'usageVerb'), n(iri(text(row(statement.verb).id)))),
    q(subject, n(ns + 'usageActivity'), n(iri(text(row(statement.object).id)))),
    q(subject, n(IE + 'forAgent'), n(agent)),
    q(subject, n(PROV + 'wasDerivedFrom'), source),
    q(subject, n(PROV + 'generatedAtTime'), l(generatedAt, n(XSD + 'dateTime'))),
    q(source, n(RDF + 'type'), n(XAPI + 'Statement')),
    q(source, n(XAPI + 'timestamp'), l(timestamp, n(XSD + 'dateTime'))),
    q(source, n(XAPI + 'stored'), l(stored, n(XSD + 'dateTime'))),
    ...concepts.map(concept => q(subject, n(ns + 'aboutConcept'), n(iri(concept.iri)))),
  ];
  const graphContent = new Writer({ format: 'N-Triples' }).quadsToString(quads);
  return {
    typeIri: ns + 'UsageRecord', recordIri, sourceStatementIri, sourceStatementId: id,
    sourceTimestamp: text(statement.timestamp), sourceStored: text(statement.stored), generatedAt,
    concepts: concepts.map(concept => ({ ...concept, origin: { ...concept.origin } })),
    unrecognizedTags: tags.filter(tag => !concepts.some(concept => concept.iri === tag)),
    graph_content: graphContent, graphSha256: createHash('sha256').update(graphContent).digest('hex'),
    inference: 'usage-only; no achievement or competency assertion',
  };
}

/** The signed route's real persistence wrapper: original first, derived evidence in the same private audience. */
export async function persistStatementWithUsage(statement: Row, deps: {
  persistStatement(statement: Row): Promise<UsageArtifactReceipt | null>;
  context(): Promise<UsageContext>;
  persistUsage(record: UsageRecord): Promise<UsageArtifactReceipt | null>;
}): Promise<UsageArtifactReceipt | null> {
  const original = await deps.persistStatement(statement);
  if (original?.persisted !== true || !usageTags(statement).length) return original;
  try {
    const context = await deps.context();
    const record = projectUsageRecord(statement, context);
    if (!record) return { ...original, usageRecord: { status: 'skipped', originalRetained: true, reason: 'No exact concept IRI in the deployed canonical or authored corpus', unrecognizedTags: usageTags(statement) } };
    const derived = await deps.persistUsage(record);
    return { ...original, persisted: derived?.persisted === true, usageRecord: {
      status: derived?.persisted === true ? 'persisted' : 'failed', originalRetained: true, recordIri: record.recordIri,
      ...(derived?.persisted === true ? {} : { reason: 'Original statement retained; derived usage artifact persistence failed' }),
      conceptIris: record.concepts.map(concept => concept.iri), unrecognizedTags: record.unrecognizedTags,
      graphSha256: record.graphSha256,
      ...(derived?.holonUri ? { holonUri: derived.holonUri } : {}),
      ...(derived?.holonUri ? { readback: { method: 'POST' as const, href: '/agent/lattice/self', uri: derived.holonUri } } : {}),
    } };
  } catch {
    // The event may already be committed. Expose partial durability and retry its same id.
    return { ...original, persisted: false, usageRecord: { status: 'failed', originalRetained: true, reason: 'The original statement was retained; derived usage evidence is incomplete' } };
  }
}
