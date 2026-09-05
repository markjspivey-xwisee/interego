/** Signed-domain/v1 composition. Installed explicitly; never an MCP tool or L1 vocabulary. */
import { renderHypermediaMarkdown } from '@interego/core';
import type {
  ResourceComposition, ResourceContext, ResourceDescriptor, ResourceView, ResourceWriteContext,
} from '../../deploy/mcp-relay/resource-compositions.js';
import {
  descriptorActionIsExecutable, parseSignedJsonDocument, prepareApplicationAction,
  resolveApplicationActionEvidence, resolveApplicationLab,
  type ApplicationLabReads, type ResolvedApplicationLab,
} from './application-lab-runtime.js';
import { previewApplicationAction } from './application-preview.js';

const PREFIX = 'urn:interego:application-view:v1:';
const REFRESH = 'urn:interego:application-view:refresh';
interface Reference {
  catalog: string;
  graph: string;
  application: string;
  mode: 'view' | 'preview' | 'execute';
  action: string;
  head: string;
  contract: string;
}

// These addresses bind what the user reviewed; they are not signatures or credentials.
// Every use re-resolves the signed documents. Only deployment config loads executable code.
function reference(value: Reference): string {
  return PREFIX + Buffer.from(JSON.stringify(value)).toString('base64url');
}
function parseReference(url: string): Reference {
  if (!url.startsWith(PREFIX) || url.length > 16384) throw new Error('invalid application view reference');
  const encoded = url.slice(PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error('invalid application view encoding');
  const parsed: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid application view binding');
  const value = parsed as Record<string, unknown>;
  const keys = ['catalog', 'graph', 'application', 'mode', 'action', 'head', 'contract'];
  if (Object.keys(value).length !== keys.length || keys.some(key => typeof value[key] !== 'string' || !value[key])) {
    throw new Error('incomplete application view binding');
  }
  if (!['view', 'preview', 'execute'].includes(String(value['mode']))) throw new Error('invalid application view operation');
  const catalog = new URL(String(value['catalog']));
  if (!['https:', 'http:'].includes(catalog.protocol) || catalog.username || catalog.password || catalog.hash) {
    throw new Error('invalid catalog descriptor URL');
  }
  return value as unknown as Reference;
}

function actor(context: ResourceContext): string {
  return context.principal;
}
function reads(context: ResourceContext): ApplicationLabReads {
  return { ...context.reads, discoverCatalogs: context.reads.discover };
}
function input(ref: Reference, context: ResourceContext) {
  return { catalogDescriptorUrl: ref.catalog, catalogGraphIri: ref.graph, applicationId: ref.application, actor: actor(context) };
}
function binding(resolved: ResolvedApplicationLab): Reference {
  return {
    catalog: resolved.catalogDescriptor.url, graph: resolved.catalogEnvelope.graphIri!,
    application: resolved.definition.id, mode: 'view', action: REFRESH,
    head: resolved.stateHead.cid, contract: resolved.activeContractEnvelope.declaredDigest,
  };
}

const escape = (value: unknown): string => String(value ?? '—').replace(/[\\`*_{}[\]<>|]/g, '\\$&').replace(/\r?\n/g, ' ');
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const atPath = (value: unknown, path: unknown): unknown => String(path ?? '').split('.').filter(Boolean).reduce<unknown>((current, key) =>
  current !== null && typeof current === 'object' && Object.prototype.hasOwnProperty.call(current, key)
    ? (current as Record<string, unknown>)[key] : undefined, value);
function table(columns: string[], rows: unknown[][]): string {
  return [columns, columns.map(() => '---'), ...rows].map(row => '| ' + row.map(escape).join(' | ') + ' |').join('\n');
}
function json(value: unknown): string {
  // Indented code keeps arbitrary signed text from introducing Markdown controls.
  return JSON.stringify(value ?? null, null, 2).split('\n').map(line => '    ' + line).join('\n');
}

function view(resolved: ResolvedApplicationLab, context: ResourceContext): ResourceView {
  const ref = binding(resolved);
  const descriptorUrl = reference(ref);
  const title = resolved.definition.title ?? resolved.definition.id;
  const snapshot = resolved.snapshot;
  const trusted = record(snapshot['trust'])['verified'] === true;
  const parts = [
    '# ' + escape(title), escape(resolved.definition.description ?? ''),
    table(['State version', 'Verification', 'Replay'], [[resolved.state.version, trusted ? 'Verified' : 'Incomplete', `${resolved.replay.verifiedLinks}/${resolved.replay.chainLength}`]]),
  ];
  const ui = resolved.definition.ui;
  const views = Array.isArray(ui?.['views']) ? ui['views'] : [];
  if (!views.length) parts.push('## Current state', json(resolved.state.data));
  for (const raw of views) {
    const spec = record(raw);
    const value = atPath(resolved.state.data, spec['path']);
    parts.push('## ' + escape(spec['label'] ?? spec['id'] ?? spec['path']));
    if (spec['kind'] === 'table' && Array.isArray(value) && Array.isArray(spec['columns'])) {
      const columns = spec['columns'].map(record);
      parts.push(table(columns.map(c => String(c['label'] ?? c['id'])), value.map(row => columns.map(c => {
        const cell = atPath(row, c['path']);
        return typeof cell === 'object' ? JSON.stringify(cell) : cell;
      }))));
    } else parts.push(typeof value === 'object' ? json(value) : escape(value));
  }
  parts.push('## Verified authority', table(['Artifact', 'Reference'], [
    ['Catalog', ref.catalog], ['State head', ref.head], ['Contract digest', ref.contract],
  ]), 'This view is derived from signed artifacts. The view address is not a new signed descriptor.');
  if (!trusted) parts.push('Actions are unavailable until the catalog is current and verification is complete.');
  if (!actor(context)) parts.push('Sign in to preview or submit an action.');
  const controls: Record<string, unknown>[] = [{
    action: REFRESH, method: 'GET', label: 'Refresh and verify', descriptorUrl,
    executable: true, fields: [], source: ref.catalog,
  }];
  const catalogApps = record(snapshot['catalog'])['applications'];
  if (Array.isArray(catalogApps)) for (const app of catalogApps.map(record)) {
    if (typeof app['applicationId'] === 'string' && app['applicationId'] !== ref.application) controls.push({
      action: REFRESH, method: 'GET', label: 'Open ' + String(app['title'] ?? app['applicationId']),
      descriptorUrl: reference({ ...ref, application: app['applicationId'] }), executable: true, fields: [], source: ref.catalog,
    });
  }
  for (const action of resolved.activeContract.actions) {
    const executable = trusted && !!actor(context) && descriptorActionIsExecutable(action);
    const fields = (action.inputs ?? []).map(field => ({
      path: field.name, key: field.name, name: field.label ?? field.name, minCount: field.required ? 1 : 0,
      datatype: 'http://www.w3.org/2001/XMLSchema#' + (field.type === 'number' ? 'double' : field.type === 'boolean' ? 'boolean' : 'string'),
      ...(field.options ? { description: 'Allowed values: ' + field.options.map(value => JSON.stringify(value)).join(', ') } : {}),
    }));
    for (const mode of ['preview', 'execute'] as const) controls.push({
      action: action.actionIri, label: (mode === 'preview' ? 'Preview: ' : 'Submit: ') + (action.label ?? action.actionIri),
      method: mode === 'preview' ? 'GET' : 'POST', fields, executable,
      descriptorUrl: reference({ ...ref, mode, action: action.actionIri }),
      source: resolved.activeContractDescriptor.url,
      whenToUse: mode === 'preview' ? 'Verify and simulate the declared action without publishing.' : action.description ?? 'Submit the declared action after reviewing its inputs.',
    });
  }
  const body = parts.join('\n\n');
  // Each action is a separate derived resource, so the HMD source links to its own
  // authority context. The chat adapter receives the corresponding inline controls.
  const hmd = renderHypermediaMarkdown({
    id: descriptorUrl, type: 'urn:interego:application-view:Projection', descriptorUrl, title, body, controls: [],
    links: controls.map(control => ({ href: String(control['descriptorUrl']), rel: String(control['action']), label: String(control['label']) })),
  });
  return { descriptorUrl, title, body, hmd, controls, authorship: null, derivedFrom: snapshot['provenance'], snapshot };
}

const composition: ResourceComposition = {
  claims: url => url.startsWith(PREFIX),
  access(url, action) {
    try {
      const ref = parseReference(url);
      if (ref.action !== action || (ref.mode === 'view' && action !== REFRESH)) return undefined;
      return ref.mode === 'execute' ? 'write' : 'read';
    } catch { return undefined; }
  },
  async render(url, context, descriptor?: ResourceDescriptor) {
    if (url.startsWith(PREFIX)) return view(await resolveApplicationLab(input(parseReference(url), context), reads(context)), context);
    if (!descriptor?.content) return undefined;
    let envelope;
    try { envelope = parseSignedJsonDocument(descriptor.content); } catch { return undefined; }
    if (!String(envelope.document['schema']).startsWith('interego.application.catalog/')) return undefined;
    if (!envelope.graphIri) throw new Error('application catalog has no graph identity');
    const resolved = await resolveApplicationLab({ catalogDescriptorUrl: url, catalogGraphIri: envelope.graphIri, actor: actor(context) }, reads(context));
    return view(resolved, context);
  },
  async invoke(url, action, payload, context) {
    const ref = parseReference(url);
    if (!composition.access(url, action)) throw new Error('undeclared application view operation');
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('payload must be an object');
    if (ref.mode === 'view') {
      if (Object.keys(payload).length) throw new Error('view operation takes no inputs');
      return view(await resolveApplicationLab(input(ref, context), reads(context)), context);
    }
    if (!actor(context)) throw new Error('authenticated actor is required');
    const request = {
      catalog_descriptor_url: ref.catalog, catalog_graph_iri: ref.graph, application_id: ref.application,
      action_iri: action, expected_head: ref.head, expected_contract_digest: ref.contract, payload,
    };
    if (ref.mode === 'preview') return previewApplicationAction(request, { actor: actor(context), now: context.now }, reads(context));
    if (!('publish' in context)) throw new Error('write capability is required');
    const write = context as ResourceWriteContext;
    const resolved = await resolveApplicationLab(input(ref, context), reads(context));
    if (resolved.activeContractEnvelope.declaredDigest !== ref.contract) throw new Error('stale application contract; refresh before submitting');
    if (resolved.stateHead.cid !== ref.head) throw new Error('stale application head; refresh before submitting');
    const evidence = await resolveApplicationActionEvidence(resolved, { actionIri: action, payload: payload as Record<string, unknown> }, reads(context));
    const authority = await resolveApplicationLab(input(ref, context), reads(context));
    if (!authority.catalogCurrent || !authority.replay.complete
      || authority.stateHead.cid !== ref.head
      || authority.catalogEnvelope.declaredDigest !== resolved.catalogEnvelope.declaredDigest
      || authority.definitionEnvelope.declaredDigest !== resolved.definitionEnvelope.declaredDigest
      || authority.activeContractEnvelope.declaredDigest !== ref.contract) {
      throw new Error('application authority changed before submission; refresh and retry');
    }
    const prepared = prepareApplicationAction(authority, {
      actionIri: action, payload: payload as Record<string, unknown>, actor: actor(context), now: context.now, expectedHead: ref.head, evidence,
    });
    const published = await write.publish({ podUrl: resolved.podUrl, graphIri: resolved.definition.stateGraphIri, graphContent: prepared.graphContent, expectedHead: ref.head, actor: actor(context) });
    if (published['error'] || published['published'] === false || published['status'] === 'failed') {
      return { error: 'application_action_refused', message: String(published['message'] ?? published['error'] ?? 'publication refused'), committed: false };
    }
    // Once publication returns successfully, a verification failure must not be
    // represented as an uncommitted action (which could prompt a duplicate retry).
    try {
      const after = await resolveApplicationLab(input(ref, context), reads(context));
      if (after.state.version !== resolved.state.version + 1 || after.stateHead.cid === ref.head
        || record(after.snapshot['trust'])['verified'] !== true || !after.replay.complete
        || after.stateEnvelope.declaredDigest !== parseSignedJsonDocument(prepared.graphContent).declaredDigest) {
        throw new Error('published successor did not independently verify as the current head');
      }
      return { status: 'committed', committed: true, receipt: prepared.receipt, published, view: view(after, context) };
    } catch (error) {
      return { error: 'successor_verification_failed', message: (error as Error).message, committed: true, published };
    }
  },
};

export default composition;
