/** Signed-domain/v1 composition. Installed explicitly; never an MCP tool or L1 vocabulary. */
import { renderHypermediaMarkdown } from '@interego/core';
import type {
  ResourceComposition, ResourceContext, ResourceDescriptor, ResourceView, ResourceWriteContext, ResourceSignatureDraft,
} from '../../deploy/mcp-relay/resource-compositions.js';
import {
  descriptorActionIsExecutable, parseSignedJsonDocument, prepareApplicationAction,
  resolveApplicationActionEvidence, resolveApplicationLab,
  applicationActionReceipt, canonicalJson,
  type ApplicationLabReads, type ResolvedApplicationLab,
} from './application-lab-runtime.js';
import { previewApplicationAction } from './application-preview.js';
import { clientKeyId, verifyClientAuthorization, type ClientSignature, type VerifiedClientAuthorization } from './client-authorization.js';

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
      method: mode === 'preview' ? 'GET' : 'POST',
      fields: mode === 'execute' && action.clientSignature ? [...fields, {
        path: 'client_proof', key: 'client_proof', name: 'Optional proof from your agent signer; leave empty to sign interactively', minCount: 0,
        datatype: 'http://www.w3.org/2001/XMLSchema#string',
      }] : fields, executable,
      descriptorUrl: reference({ ...ref, mode, action: action.actionIri }),
      source: resolved.activeContractDescriptor.url,
      whenToUse: mode === 'preview' ? 'Verify and simulate the declared action without publishing. Actions requiring a client signature return a signing request.' : action.description ?? 'Submit the declared action after reviewing its inputs.',
    });
  }
  if (resolved.activeContract.actions.some(action => action.clientSignature)) parts.push(
    '## Client signatures',
    'Preview to inspect the action. Submit starts a secure signing request and automatically verifies and submits your signature. An agent with its own registered key can also supply client_proof directly. The private key stays with its holder.',
    table(['Transition', 'Authorization', 'Signing key'], resolved.replay.links.filter(link => link.index > 0)
      .map(link => [link.version, link.authorizationBasis, link.clientKeyId ?? 'Relay key'])),
  );
  const body = parts.join('\n\n');
  // Each action is a separate derived resource, so the HMD source links to its own
  // authority context. The chat adapter receives the corresponding inline controls.
  const hmd = renderHypermediaMarkdown({
    id: descriptorUrl, type: 'urn:interego:application-view:Projection', descriptorUrl, title, body, controls: [],
    links: controls.map(control => ({ href: String(control['descriptorUrl']), rel: String(control['action']), label: String(control['label']) })),
  });
  return { descriptorUrl, title, body, hmd, controls, authorship: null, derivedFrom: snapshot['provenance'], snapshot };
}

async function prepareSignature(url: string, action: string, payload: Record<string, unknown>, context: ResourceContext): Promise<ResourceSignatureDraft> {
  const ref = parseReference(url);
  if (ref.mode !== 'execute' || action !== ref.action || !actor(context)) throw new Error('invalid signing operation');
  const resolved = await resolveApplicationLab(input(ref, context), reads(context));
  if (resolved.activeContractEnvelope.declaredDigest !== ref.contract) throw new Error('contract changed; request a new action review');
  const evidence = await resolveApplicationActionEvidence(resolved, { actionIri: action, payload }, reads(context));
  const current = { ...binding(resolved), mode: 'execute' as const, action };
  const draft = applicationActionReceipt(resolved, { actionIri: action, payload, actor: actor(context), now: context.now, expectedHead: current.head, evidence });
  if (!draft.action.clientSignature) throw new Error('action does not require a client signature');
  if (!context.signingKeys) throw new Error('registered client signing keys are unavailable');
  const receipt = draft.receipt;
  const authority = record(receipt['authority']);
  // State can advance between independent reviewers. Only a NEW review and signature
  // may bind that new state. Contract, catalog, definition, evidence and inputs cannot.
  const immutable = { ...receipt, at: undefined, expectedHead: undefined, stateVersion: undefined,
    authority: { ...authority, stateDescriptorUrl: undefined, stateDigest: undefined } };
  return { reference: reference(current), binding: canonicalJson(JSON.parse(JSON.stringify(immutable))),
    request: { schema: 'interego.client-signing-request/v1', message: canonicalJson(receipt),
      keys: (await context.signingKeys()).map(key => ({ keyId: clientKeyId(key), key })),
      expiresAt: new Date(Date.parse(context.now) + 600_000).toISOString() } };
}

const composition: ResourceComposition = {
  prepareSignature,
  async validateSignature(url, action, payload, rawProof, context) {
    const ref = parseReference(url);
    if (ref.mode !== 'execute' || ref.action !== action) throw new Error('invalid signing operation');
    const resolved = await resolveApplicationLab(input(ref, context), reads(context));
    if (resolved.stateHead.cid !== ref.head) throw new Error('state changed; load and review a fresh receipt');
    if (resolved.activeContractEnvelope.declaredDigest !== ref.contract) throw new Error('contract changed; request a new action review');
    if (!context.signingKeys) throw new Error('registered client signing keys are unavailable');
    const proof = rawProof as ClientSignature;
    const at = String(record(JSON.parse(proof.message))['at'] ?? '');
    const age = Date.parse(context.now) - Date.parse(at);
    if (!Number.isFinite(age) || age < -30_000 || age > 600_000) throw new Error('signature expired; load and review a fresh receipt');
    const evidence = await resolveApplicationActionEvidence(resolved, { actionIri: action, payload }, reads(context));
    const draft = applicationActionReceipt(resolved, { actionIri: action, payload, actor: actor(context), now: at, expectedHead: ref.head, evidence });
    const authorization = await verifyClientAuthorization(proof, canonicalJson(draft.receipt), await context.signingKeys());
    prepareApplicationAction(resolved, { actionIri: action, payload, actor: actor(context), now: at, expectedHead: ref.head, evidence, authorization });
  },
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
    const wirePayload = { ...payload as Record<string, unknown> };
    const rawProof = wirePayload['client_proof'];
    delete wirePayload['client_proof'];
    const request = {
      catalog_descriptor_url: ref.catalog, catalog_graph_iri: ref.graph, application_id: ref.application,
      action_iri: action, expected_head: ref.head, expected_contract_digest: ref.contract, payload: wirePayload,
    };
    if (ref.mode === 'preview') {
      const preview = await previewApplicationAction(request, { actor: actor(context), now: context.now }, reads(context));
      const resolved = await resolveApplicationLab(input(ref, context), reads(context));
      const declared = resolved.activeContract.actions.find(value => value.actionIri === action);
      if (!declared?.clientSignature) return preview;
      if (resolved.activeContractEnvelope.declaredDigest !== ref.contract) throw new Error('stale application contract; refresh before signing');
      const evidence = await resolveApplicationActionEvidence(resolved, { actionIri: action, payload: wirePayload }, reads(context));
      const draft = applicationActionReceipt(resolved, { actionIri: action, payload: wirePayload, actor: actor(context), now: context.now, expectedHead: ref.head, evidence });
      if (!context.signingKeys) throw new Error('this transport cannot resolve registered client signing keys');
      const keys = (await context.signingKeys()).map(key => ({ keyId: clientKeyId(key), key }));
      const signingRequest = { schema: 'interego.client-signing-request/v1', message: canonicalJson(draft.receipt), keys,
        expiresAt: new Date(Date.parse(context.now) + 10 * 60_000).toISOString() };
      const origins = new Set([new URL(context.identityUrl).origin, ...keys.flatMap(value => value.key.origins ?? [])]);
      const fragment = Buffer.from(JSON.stringify(signingRequest)).toString('base64url');
      return { ...preview, signingRequest,
        signingUrls: [...origins].map(origin => `${origin}/sign-action#${fragment}`),
        message: 'Read-only preview. A runtime with its own registered signer can review this receipt and submit client_proof through MCP. Otherwise invoke the advertised Submit control without a proof to open the interactive signing panel. Do not ask the user to copy a URL or proof JSON.',
      };
    }
    if (!('publish' in context)) throw new Error('write capability is required');
    const write = context as ResourceWriteContext;
    const resolved = await resolveApplicationLab(input(ref, context), reads(context));
    if (resolved.activeContractEnvelope.declaredDigest !== ref.contract) throw new Error('stale application contract; refresh before submitting');
    if (resolved.stateHead.cid !== ref.head) throw new Error('stale application head; refresh before submitting');
    const evidence = await resolveApplicationActionEvidence(resolved, { actionIri: action, payload: wirePayload }, reads(context));
    const declared = resolved.activeContract.actions.find(value => value.actionIri === action);
    if (rawProof !== undefined && declared?.clientSignature !== true) throw new Error('this action does not declare client signature input');
    let authorization: VerifiedClientAuthorization | undefined;
    let actionTime = context.now;
    if (declared?.clientSignature || rawProof !== undefined) {
      if (!rawProof) {
        if (!write.requestSignature) throw new Error('client signature is required; signing handoff is unavailable here, so use your registered agent signer');
        const draft = await prepareSignature(url, action, wirePayload, context);
        return write.requestSignature(url, action, wirePayload, draft);
      }
      const proof = (typeof rawProof === 'string' ? JSON.parse(rawProof) : rawProof) as ClientSignature;
      const signedReceipt = JSON.parse(proof.message) as Record<string, unknown>;
      actionTime = typeof signedReceipt['at'] === 'string' ? signedReceipt['at'] : '';
      const age = Date.parse(context.now) - Date.parse(actionTime);
      if (!Number.isFinite(age) || age < -30_000 || age > 10 * 60_000) throw new Error('client signature expired or has an invalid time; preview and sign again');
      if (!context.signingKeys) throw new Error('registered client signing keys are unavailable');
      const draft = applicationActionReceipt(resolved, { actionIri: action, payload: wirePayload, actor: actor(context), now: actionTime, expectedHead: ref.head, evidence });
      authorization = await verifyClientAuthorization(proof, canonicalJson(draft.receipt), await context.signingKeys());
    }
    const authority = await resolveApplicationLab(input(ref, context), reads(context));
    if (!authority.catalogCurrent || !authority.replay.complete
      || authority.stateHead.cid !== ref.head
      || authority.catalogEnvelope.declaredDigest !== resolved.catalogEnvelope.declaredDigest
      || authority.definitionEnvelope.declaredDigest !== resolved.definitionEnvelope.declaredDigest
      || authority.activeContractEnvelope.declaredDigest !== ref.contract) {
      throw new Error('application authority changed before submission; refresh and retry');
    }
    const prepared = prepareApplicationAction(authority, {
      actionIri: action, payload: wirePayload, actor: actor(context), now: actionTime, expectedHead: ref.head, evidence, authorization,
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
