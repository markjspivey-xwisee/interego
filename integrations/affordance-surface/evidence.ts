/** Read-only evidence composition declared by a signed affordance surface. */
import type { ResourceContext, ResourceDescriptor } from '../../deploy/mcp-relay/resource-compositions.js';
import {
  canonicalJson, descriptorTrusted, parseSignedJsonDocument, resolveApplicationLab,
  type ReplayReport,
} from '../application-runtime/application-lab-runtime.js';

type PathReference = { document: string; path: string };
type ApplicationDocument = {
  id: string; kind: 'application'; catalogDescriptorUrl: string;
  catalogGraphIri: string; applicationId: string; signer: string;
};
type JsonDocument = { id: string; kind: 'signed-json'; descriptorUrl: string; digest: string; signer: string };
type CurrentAuthority = { role: string; podUrl: string; graphIri: string; descriptorUrl: string; cid: string };
type EvidenceSpec = {
  documents: (ApplicationDocument | JsonDocument)[];
  equalities: { left: PathReference; right: PathReference }[];
  recordedState?: PathReference;
  summaries: (PathReference & { label: string })[];
};
export interface SurfaceEvidence {
  readonly verified: boolean;
  readonly artifactsVerified: number;
  readonly artifactsTotal: number;
  /** These are histories of the related applications, not of the surface's current state. */
  readonly replay?: readonly { document: string; label: string; report: ReplayReport }[];
  readonly body: string;
  readonly links: readonly { href: string; rel: 'describedby'; label: string }[];
  readonly matchesCurrentState?: boolean;
}

const own = (object: object, key: string): boolean => Object.prototype.hasOwnProperty.call(object, key);
function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error(`invalid ${label}`);
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[], label: string): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error(`unknown ${label} field`);
}
function text(value: unknown, label: string, max = 2048): string {
  if (typeof value !== 'string' || !value || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`invalid ${label}`);
  return value;
}
function url(value: unknown): string {
  const string = text(value, 'evidence descriptor URL');
  const parsed = new URL(string);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) throw new Error('invalid evidence descriptor URL');
  return string;
}
function iri(value: unknown, label: string): string {
  const string = text(value, label);
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:[^\s<>]+$/.test(string)) throw new Error(`invalid ${label}`);
  return string;
}
function list(value: unknown, label: string, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) throw new Error(`invalid ${label}`);
  return value;
}
function path(value: unknown): string {
  const string = text(value, 'evidence path', 512);
  const parts = string.split('.');
  if (parts.length > 16 || parts.some(part => !/^[A-Za-z0-9_$-]+$/.test(part)
    || ['__proto__', 'prototype', 'constructor'].includes(part))) throw new Error('invalid evidence path');
  return string;
}
function reference(raw: unknown, ids: Set<string>, withLabel = false): PathReference & { label?: string } {
  const value = record(raw, 'evidence reference');
  keys(value, withLabel ? ['document', 'path', 'label'] : ['document', 'path'], 'evidence reference');
  const document = text(value['document'], 'evidence document ID', 64);
  if (!ids.has(document)) throw new Error('unknown evidence document reference');
  return { document, path: path(value['path']), ...(withLabel ? { label: text(value['label'], 'evidence summary label', 128) } : {}) };
}
function parseSpec(raw: unknown): EvidenceSpec {
  const value = record(raw, 'surface evidence');
  keys(value, ['documents', 'equalities', 'recordedState', 'summaries'], 'surface evidence');
  const ids = new Set<string>();
  const documents = list(value['documents'], 'evidence documents', 8).map((raw): ApplicationDocument | JsonDocument => {
    const document = record(raw, 'evidence document');
    const id = text(document['id'], 'evidence document ID', 64);
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(id) || ids.has(id)) throw new Error('invalid or duplicate evidence document ID');
    ids.add(id);
    const signer = iri(document['signer'], 'evidence signer');
    if (document['kind'] === 'application') {
      keys(document, ['id', 'kind', 'catalogDescriptorUrl', 'catalogGraphIri', 'applicationId', 'signer'], 'application evidence');
      return { id, kind: 'application', signer, catalogDescriptorUrl: url(document['catalogDescriptorUrl']),
        catalogGraphIri: iri(document['catalogGraphIri'], 'evidence catalog graph'), applicationId: text(document['applicationId'], 'evidence application ID') };
    }
    if (document['kind'] !== 'signed-json') throw new Error('unknown evidence document kind');
    keys(document, ['id', 'kind', 'descriptorUrl', 'digest', 'signer'], 'signed JSON evidence');
    const digest = text(document['digest'], 'evidence digest', 64);
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('invalid evidence digest');
    return { id, kind: 'signed-json', signer, descriptorUrl: url(document['descriptorUrl']), digest };
  });
  if (!documents.length) throw new Error('surface evidence has no documents');
  const equalities = list(value['equalities'] ?? [], 'evidence equalities', 32).map(raw => {
    const equality = record(raw, 'evidence equality');
    keys(equality, ['left', 'right'], 'evidence equality');
    return { left: reference(equality['left'], ids), right: reference(equality['right'], ids) };
  });
  const summaries = list(value['summaries'] ?? [], 'evidence summaries', 16)
    .map(raw => reference(raw, ids, true) as PathReference & { label: string });
  return { documents, equalities, summaries,
    ...(value['recordedState'] !== undefined ? { recordedState: reference(value['recordedState'], ids) } : {}) };
}

function at(documents: Map<string, unknown>, reference: PathReference): unknown {
  let value = documents.get(reference.document);
  for (const key of reference.path.split('.')) {
    if (!value || typeof value !== 'object' || !own(value, key)
      || (Array.isArray(value) && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) > 10000))) throw new Error('evidence path does not exist');
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (!property || !own(property, 'value')) throw new Error('evidence path is not a data property');
    value = property.value;
  }
  if (value === undefined) throw new Error('evidence path has no value');
  return value;
}

/** Signed prose may contain Markdown, HTML, or HMD; render it only as bounded plain text. */
function plain(value: unknown, max = 512): string {
  const string = typeof value === 'string' ? value : canonicalJson(value);
  const collapsed = string.replace(/[\u0000-\u001f\u007f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, ' ');
  const bounded = collapsed.length > max ? collapsed.slice(0, max) + '…' : collapsed;
  return bounded.replace(/[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/g, '\\$&');
}
function boundDescriptor(descriptor: ResourceDescriptor, descriptorUrl: string, signer: string): void {
  if (descriptor.url !== descriptorUrl || !descriptor.cid || !descriptorTrusted(descriptor)
    || descriptor.authorship?.signedBy !== signer || !descriptor.authorship.verificationMethod) {
    throw new Error('evidence descriptor is not bound to its expected URL and signer');
  }
}

export async function verifySurfaceEvidence(raw: unknown, context: ResourceContext, bindings: { stateHeadCid: string }): Promise<SurfaceEvidence> {
  const spec = parseSpec(raw);
  text(bindings.stateHeadCid, 'current state head CID');
  const documents = new Map<string, unknown>();
  let artifactsTotal = 0;
  const histories: { document: string; label: string; report: ReplayReport }[] = [];
  const links: { href: string; rel: 'describedby'; label: string }[] = [];
  const loaded = await Promise.all(spec.documents.map(async spec => {
    if (spec.kind === 'signed-json') {
      const descriptor = await context.reads.descriptor(spec.descriptorUrl);
      boundDescriptor(descriptor, spec.descriptorUrl, spec.signer);
      const envelope = parseSignedJsonDocument(descriptor.content ?? descriptor.turtle ?? '');
      if (!envelope.digestVerified || envelope.declaredDigest !== spec.digest) throw new Error('evidence signed JSON digest mismatch');
      return { spec, value: envelope.document, artifacts: 1, href: spec.descriptorUrl, authorities: [] as CurrentAuthority[] };
    }
    const resolved = await resolveApplicationLab({ catalogDescriptorUrl: spec.catalogDescriptorUrl, catalogGraphIri: spec.catalogGraphIri,
      applicationId: spec.applicationId, actor: context.principal }, {
      discoverCatalogs: graph => context.reads.discover(graph),
      currentHead: (pod, graph) => context.reads.currentHead(pod, graph),
      discoverGraph: (pod, graph) => context.reads.discoverGraph(pod, graph),
      descriptor: descriptor => context.reads.descriptor(descriptor),
    });
    boundDescriptor(resolved.catalogDescriptor, spec.catalogDescriptorUrl, spec.signer);
    const trust = record(resolved.snapshot['trust'], 'application evidence trust');
    const provenance = list(resolved.snapshot['provenance'], 'application evidence provenance', 256);
    if (resolved.catalogEnvelope.graphIri !== spec.catalogGraphIri || !resolved.catalogCurrent || trust['verified'] !== true
      || !provenance.length || provenance.some(raw => record(raw, 'application evidence artifact')['trusted'] !== true)
      || trust['artifactsTotal'] !== provenance.length || trust['artifactsVerified'] !== provenance.length
      || !resolved.replay.complete || resolved.replay.errors.length !== 0 || resolved.replay.chainLength < 1
      || resolved.replay.verifiedLinks !== resolved.replay.chainLength
      || resolved.replay.links.length !== resolved.replay.chainLength
      || resolved.replay.links.some(link => !link.verified || link.errors.length !== 0)) throw new Error('related application evidence is incomplete or not current');
    const application = record(resolved.snapshot['application'], 'application evidence identity');
    const authorities: CurrentAuthority[] = [
      { role: 'catalog', podUrl: resolved.podUrl, graphIri: spec.catalogGraphIri,
        descriptorUrl: spec.catalogDescriptorUrl, cid: resolved.catalogDescriptor.cid! },
      { role: 'state', podUrl: resolved.podUrl, graphIri: iri(application['stateGraphIri'], 'application state graph'),
        descriptorUrl: resolved.stateHead.descriptorUrl, cid: resolved.stateHead.cid },
    ];
    if (application['governanceGraphIri']) {
      const governance = provenance.map(value => record(value, 'application evidence artifact')).filter(value => value['role'] === 'governance-head');
      if (governance.length !== 1) throw new Error('related application governance authority is missing or ambiguous');
      authorities.push({ role: 'governance', podUrl: resolved.podUrl,
        graphIri: iri(application['governanceGraphIri'], 'application governance graph'),
        descriptorUrl: url(governance[0]!['descriptorUrl']), cid: text(governance[0]!['cid'], 'application governance CID') });
    }
    return { spec, value: resolved.snapshot, artifacts: provenance.length, href: spec.catalogDescriptorUrl, replay: resolved.replay, authorities };
  }));
  // Recheck selectors after every document finishes loading: another document may
  // be slow, while application state or its governance advances under the same catalog.
  // Definitions and contracts remain the exact epochs pinned by these authorities.
  await Promise.all(loaded.flatMap(item => item.authorities).map(async authority => {
    const current = await context.reads.currentHead(authority.podUrl, authority.graphIri);
    if (current.forked || current.head?.descriptorUrl !== authority.descriptorUrl || current.head.cid !== authority.cid) {
      throw new Error(`related application ${authority.role} changed during verification`);
    }
  }));
  for (const item of loaded) {
    documents.set(item.spec.id, item.value);
    artifactsTotal += item.artifacts;
    links.push({ href: item.href, rel: 'describedby', label: `Evidence: ${item.spec.id}` });
    if (item.replay) histories.push({ document: item.spec.id, label: `Related application history: ${item.spec.id}`, report: item.replay });
  }
  for (const equality of spec.equalities) {
    if (canonicalJson(at(documents, equality.left)) !== canonicalJson(at(documents, equality.right))) throw new Error('surface evidence equality does not match');
  }
  const lines = [`Verified related evidence: ${artifactsTotal}/${artifactsTotal} artifacts.`];
  for (const history of histories) lines.push(`${plain(history.label)}: ${history.report.verifiedLinks}/${history.report.chainLength} verified links.`);
  let matchesCurrentState: boolean | undefined;
  if (spec.recordedState) {
    const recorded = text(at(documents, spec.recordedState), 'recorded state head CID');
    matchesCurrentState = recorded === bindings.stateHeadCid;
    lines.push(matchesCurrentState ? 'Recorded evidence names the current authoritative state.'
      : 'Historical evidence: its recorded state differs from the current authoritative state.');
  }
  for (const summary of spec.summaries) lines.push(`${plain(summary.label, 128)}: ${plain(at(documents, summary))}`);
  return { verified: true, artifactsVerified: artifactsTotal, artifactsTotal, body: lines.join('\n\n'), links,
    ...(histories.length ? { replay: histories } : {}), ...(matchesCurrentState !== undefined ? { matchesCurrentState } : {}) };
}
