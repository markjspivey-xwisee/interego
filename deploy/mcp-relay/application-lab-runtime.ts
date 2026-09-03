/**
 * Generic runtime for the Interego Application Lab.
 *
 * An application is not installed code.  It is a verified relationship between a
 * signed catalog entry, a signed definition, a signed action contract, and a
 * supersession chain of signed state documents.  This module deliberately knows
 * nothing about Release Control (or any other vertical): every label, view, guard,
 * effect, and action comes from those documents.
 *
 * The server supplies four read capabilities below.  Keeping the resolver here
 * free of relay globals makes the security-sensitive parts -- canonical JSON,
 * digest binding, guard evaluation, minimal effects, and complete replay --
 * directly testable.
 */

import { createHash } from 'node:crypto';
import { turtleIriRef } from '@interego/core';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface LabAuthorship {
  readonly authorshipVerified?: boolean;
  readonly contentBinding?: string;
  readonly contentBindingNote?: string;
  readonly descriptorBinding?: { readonly bound?: boolean; readonly basis?: string; readonly note?: string };
  readonly effectiveTrustLevel?: string;
  readonly signedBy?: string;
  readonly verificationMethod?: string;
  readonly reason?: string;
}

export interface LabDescriptor {
  readonly url: string;
  readonly cid?: string;
  readonly turtle?: string;
  readonly content?: string;
  readonly authorship?: LabAuthorship | null;
}

export interface LabManifestEntry {
  readonly descriptorUrl: string;
  readonly cid?: string | null;
  readonly validFrom?: string | null;
  readonly supersedes?: readonly string[] | null;
  readonly describes?: readonly string[] | null;
}

export interface LabHead {
  readonly forked?: boolean;
  readonly head?: { readonly descriptorUrl?: string | null; readonly cid?: string | null } | null;
  readonly heads?: readonly { readonly descriptorUrl?: string | null; readonly cid?: string | null }[] | null;
  readonly message?: string | null;
}

export interface ApplicationLabReads {
  discoverCatalogs(graphIri: string): Promise<readonly { podUrl: string; entry: LabManifestEntry }[]>;
  currentHead(podUrl: string, graphIri: string): Promise<LabHead>;
  discoverGraph(podUrl: string, graphIri: string): Promise<readonly LabManifestEntry[]>;
  descriptor(url: string): Promise<LabDescriptor>;
}

export interface SignedJsonEnvelope {
  readonly document: Record<string, Json>;
  readonly canonical: string;
  readonly declaredDigest: string;
  readonly computedDigest: string;
  readonly digestVerified: boolean;
  readonly documentType?: string;
  readonly graphIri?: string;
}

export interface ApplicationActionInput {
  readonly name: string;
  readonly label?: string;
  readonly type?: string;
  readonly required?: boolean;
  readonly options?: readonly Json[];
}

export interface ApplicationAction {
  readonly actionIri: string;
  readonly label?: string;
  readonly description?: string;
  readonly method?: string;
  readonly target?: string;
  readonly goal?: string;
  readonly guard?: Json;
  readonly effects?: readonly Record<string, Json>[];
  readonly inputs?: readonly ApplicationActionInput[];
}

export interface ApplicationContract {
  readonly schema: string;
  readonly applicationId: string;
  readonly version?: string;
  readonly runtimeIri?: string;
  readonly actions: readonly ApplicationAction[];
}

export interface ApplicationDefinition {
  readonly schema: string;
  readonly id: string;
  readonly title?: string;
  readonly description?: string;
  readonly stateGraphIri: string;
  readonly contractGraphIri: string;
  readonly ui?: Record<string, Json>;
}

export interface ApplicationState {
  readonly schema: string;
  readonly applicationId: string;
  readonly version: number;
  readonly data: Record<string, Json>;
  readonly transition?: Record<string, Json>;
}

export interface ArtifactEvidence {
  readonly role: string;
  readonly descriptorUrl: string;
  readonly cid?: string | null;
  readonly signedBy?: string;
  readonly verificationMethod?: string;
  readonly authorshipVerified: boolean;
  readonly contentBinding: string;
  readonly descriptorBinding: boolean;
  readonly digestVerified: boolean;
  readonly trusted: boolean;
  readonly reason?: string;
}

export interface ReplayLink {
  readonly index: number;
  readonly version?: number;
  readonly descriptorUrl: string;
  readonly cid?: string | null;
  readonly actionIri?: string;
  readonly actor?: string;
  readonly at?: string;
  readonly contractDigest?: string;
  readonly contractVersion?: string;
  readonly trusted: boolean;
  readonly digestVerified: boolean;
  readonly receiptVerified: boolean;
  readonly priorVerified: boolean;
  readonly guardVerified: boolean;
  readonly effectVerified: boolean;
  readonly verified: boolean;
  readonly errors: readonly string[];
}

export interface ReplayReport {
  readonly complete: boolean;
  readonly chainLength: number;
  readonly transitions: number;
  readonly verifiedLinks: number;
  readonly contractEpochs: readonly { digest: string; version?: string; descriptorUrl: string; links: number }[];
  readonly links: readonly ReplayLink[];
  readonly errors: readonly string[];
}

export interface ResolvedApplicationLab {
  readonly snapshot: Record<string, Json>;
  readonly podUrl: string;
  readonly catalogCurrent: boolean;
  readonly catalogDescriptor: LabDescriptor;
  readonly catalogEnvelope: SignedJsonEnvelope;
  readonly catalogEntry: Record<string, Json>;
  readonly definitionDescriptor: LabDescriptor;
  readonly definitionEnvelope: SignedJsonEnvelope;
  readonly definition: ApplicationDefinition;
  readonly activeContractDescriptor: LabDescriptor;
  readonly activeContractEnvelope: SignedJsonEnvelope;
  readonly activeContract: ApplicationContract;
  readonly stateHead: { readonly descriptorUrl: string; readonly cid: string };
  readonly stateDescriptor: LabDescriptor;
  readonly stateEnvelope: SignedJsonEnvelope;
  readonly state: ApplicationState;
  readonly replay: ReplayReport;
}

export interface ResolveApplicationLabInput {
  readonly catalogGraphIri?: string;
  readonly catalogDescriptorUrl?: string;
  readonly podUrl?: string;
  readonly applicationId?: string;
  readonly actor?: string;
}

const DEFAULT_CATALOG_IRI = 'urn:graph:interego:application-catalog:v1';
const SIGNED_DOMAIN_RUNTIME = 'urn:interego:runtime:signed-domain:v1';

function isRecord(v: unknown): v is Record<string, Json> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** RFC-8785-shaped canonical JSON for the JSON subset used by application documents. */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonical JSON refuses non-finite numbers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
  }
  throw new Error(`canonical JSON cannot encode ${typeof value}`);
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Decode the self-describing SignedJsonDocument used by emergent applications. */
export function parseSignedJsonDocument(turtle: string): SignedJsonEnvelope {
  const encoded = /(?:\bia:jsonBase64|<urn:interego:application:jsonBase64>)\s+"([A-Za-z0-9+/=]+)"/.exec(turtle)?.[1];
  const declaredDigest = /(?:\bia:sha256|<urn:interego:application:sha256>)\s+"([0-9a-fA-F]{64})"/.exec(turtle)?.[1]?.toLowerCase();
  const documentType = /(?:\bia:documentType|<urn:interego:application:documentType>)\s+"([^"\\]*(?:\\.[^"\\]*)*)"/.exec(turtle)?.[1];
  const graphIri = /#\s*[-─ ]*Named Graph Content[^\n]*\n\s*<([^>]+)>\s*\{/.exec(turtle)?.[1]
    ?? /\n\s*<(urn:graph:[^>]+)>\s*\{/.exec(turtle)?.[1];
  if (!encoded) throw new Error('signed JSON graph has no ia:jsonBase64 literal');
  if (!declaredDigest) throw new Error('signed JSON graph has no 64-hex ia:sha256 literal');
  const canonical = Buffer.from(encoded, 'base64').toString('utf8');
  let parsed: unknown;
  try { parsed = JSON.parse(canonical); } catch (err) {
    throw new Error(`ia:jsonBase64 is not JSON: ${(err as Error).message}`);
  }
  if (!isRecord(parsed)) throw new Error('signed JSON document must be an object');
  const recanonical = canonicalJson(parsed);
  if (recanonical !== canonical) throw new Error('signed JSON bytes are not canonical-json/v1');
  const computedDigest = sha256Hex(canonical);
  return {
    document: parsed,
    canonical,
    declaredDigest,
    computedDigest,
    digestVerified: computedDigest === declaredDigest,
    ...(documentType ? { documentType } : {}),
    ...(graphIri ? { graphIri } : {}),
  };
}

export function signedJsonGraph(graphIri: string, documentType: string, document: Record<string, Json>): {
  readonly graphContent: string;
  readonly canonical: string;
  readonly digest: string;
} {
  const graphRef = turtleIriRef(graphIri);
  if (graphRef === null) throw new Error(`application graph IRI cannot be serialized safely: ${graphIri}`);
  const canonical = canonicalJson(document);
  const digest = sha256Hex(canonical);
  const jsonBase64 = Buffer.from(canonical, 'utf8').toString('base64');
  return {
    canonical,
    digest,
    graphContent: [
      '@prefix ia: <urn:interego:application:> .',
      '',
      `${graphRef} {`,
      `  ${graphRef} a ia:SignedJsonDocument ;`,
      '    ia:format "canonical-json/v1" ;',
      `    ia:documentType ${JSON.stringify(documentType)} ;`,
      `    ia:sha256 ${JSON.stringify(digest)} ;`,
      `    ia:jsonBase64 ${JSON.stringify(jsonBase64)} .`,
      '}',
      '',
    ].join('\n'),
  };
}

export function descriptorTrusted(descriptor: LabDescriptor, envelope?: SignedJsonEnvelope): boolean {
  const a = descriptor.authorship;
  return !!a?.authorshipVerified
    && a.contentBinding === 'bound'
    && a.descriptorBinding?.bound === true
    && (envelope ? envelope.digestVerified : true);
}

function evidence(role: string, descriptor: LabDescriptor, envelope: SignedJsonEnvelope, cid?: string | null): ArtifactEvidence {
  const a = descriptor.authorship;
  const trusted = descriptorTrusted(descriptor, envelope);
  return {
    role,
    descriptorUrl: descriptor.url,
    ...(cid !== undefined ? { cid } : {}),
    ...(a?.signedBy ? { signedBy: a.signedBy } : {}),
    ...(a?.verificationMethod ? { verificationMethod: a.verificationMethod } : {}),
    authorshipVerified: a?.authorshipVerified === true,
    contentBinding: a?.contentBinding ?? 'unbound',
    descriptorBinding: a?.descriptorBinding?.bound === true,
    digestVerified: envelope.digestVerified,
    trusted,
    ...(!trusted ? { reason: a?.reason ?? a?.contentBindingNote ?? 'one or more verification bindings failed' } : {}),
  };
}

function descriptorPayload(d: LabDescriptor): string {
  const text = d.content ?? d.turtle ?? '';
  if (!text) throw new Error(`descriptor ${d.url} has no readable graph payload`);
  return text;
}

function podFromDescriptorUrl(url: string): string {
  const marker = '/context-graphs/';
  const at = url.indexOf(marker);
  if (at < 0) throw new Error(`catalog descriptor URL is not in a context-graphs container: ${url}`);
  return `${url.slice(0, at)}/`;
}

function asString(v: Json | undefined): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function asRecord(v: Json | undefined): Record<string, Json> | undefined {
  return isRecord(v) ? v : undefined;
}

function artifactRef(entry: Record<string, Json>, role: 'contract' | 'definition' | 'genesisState'): Record<string, Json> | undefined {
  return asRecord(asRecord(entry['manifestCids'])?.[role]);
}

function jsonEqual(a: unknown, b: unknown): boolean {
  try { return canonicalJson(a) === canonicalJson(b); } catch { return false; }
}

function getPath(root: Record<string, unknown>, path: string): unknown {
  const clean = path.replace(/^\$/, '').replace(/^\./, '');
  if (!clean) return root;
  let cur: unknown = root;
  for (const part of clean.split('.')) {
    if (cur == null || (typeof cur !== 'object' && !Array.isArray(cur))) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function resolveValue(value: unknown, env: Record<string, unknown>): unknown {
  if (typeof value === 'string' && value.startsWith('$')) return getPath(env, value);
  if (Array.isArray(value)) return value.map(v => resolveValue(v, env));
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj['path'] === 'string' && Object.keys(obj).length === 1) return getPath(env, obj['path']);
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, resolveValue(v, env)]));
  }
  return value;
}

function matchesWhere(item: unknown, where: unknown, env: Record<string, unknown>): boolean {
  if (!where || typeof where !== 'object') return false;
  const w = where as Record<string, unknown>;
  const itemEnv = { ...env, item };
  if ('itemPath' in w && 'eq' in w) {
    const left = getPath({ item }, `$item.${String(w['itemPath'])}`);
    return jsonEqual(left, resolveValue(w['eq'], itemEnv));
  }
  return evaluateGuard(where, itemEnv).pass;
}

export interface GuardResult { readonly pass: boolean; readonly explanation: string; readonly supported: boolean }

/** Evaluate the declarative guard vocabulary. Unknown operators fail closed. */
export function evaluateGuard(guard: unknown, env: Record<string, unknown>): GuardResult {
  if (guard === true || guard === undefined || guard === null) return { pass: true, explanation: 'always', supported: true };
  if (guard === false) return { pass: false, explanation: 'never', supported: true };
  if (!guard || typeof guard !== 'object') return { pass: false, explanation: 'invalid guard', supported: false };
  const g = guard as Record<string, unknown>;
  const op = String(g['op'] ?? '');
  if (op === 'all' || op === 'any') {
    const children = Array.isArray(g['guards']) ? g['guards'] : [];
    const rs = children.map(c => evaluateGuard(c, env));
    const pass = op === 'all' ? rs.every(r => r.pass) : rs.some(r => r.pass);
    return { pass, supported: rs.every(r => r.supported), explanation: `${op}(${rs.map(r => r.pass ? 'pass' : 'fail').join(', ')})` };
  }
  if (op === 'eq' || op === 'ne') {
    const equal = jsonEqual(resolveValue(g['left'], env), resolveValue(g['right'], env));
    return { pass: op === 'eq' ? equal : !equal, supported: true, explanation: `${op}: ${op === 'eq' ? equal : !equal}` };
  }
  if (op === 'none' || op === 'exists') {
    const list = getPath(env, String(g['path'] ?? ''));
    if (!Array.isArray(list)) return { pass: false, supported: true, explanation: `${op}: path is not an array` };
    const count = list.filter(item => matchesWhere(item, g['where'], env)).length;
    return { pass: op === 'none' ? count === 0 : count > 0, supported: true, explanation: `${op}: ${count} match${count === 1 ? '' : 'es'}` };
  }
  if (op === 'countDistinct') {
    const list = getPath(env, String(g['path'] ?? ''));
    if (!Array.isArray(list)) return { pass: false, supported: true, explanation: 'countDistinct: path is not an array' };
    const itemPath = String(g['itemPath'] ?? '');
    const distinct = new Set(list.map(item => canonicalJson(getPath({ item }, `$item.${itemPath}`)))).size;
    const gte = Number(g['gte'] ?? 0);
    return { pass: distinct >= gte, supported: true, explanation: `countDistinct: ${distinct} >= ${gte}` };
  }
  if (op === 'not') {
    const r = evaluateGuard(g['guard'], env);
    return { pass: !r.pass, supported: r.supported, explanation: `not(${r.explanation})` };
  }
  return { pass: false, explanation: `unsupported guard operator: ${op || '(missing)'}`, supported: false };
}

function setPath(state: Record<string, Json>, path: string, value: Json): void {
  const clean = path.replace(/^\$state\.?/, '');
  if (!clean) throw new Error('an effect may not replace $state wholesale');
  const parts = clean.split('.');
  let cursor: Record<string, Json> = state;
  for (const p of parts.slice(0, -1)) {
    const next = cursor[p];
    if (!isRecord(next)) cursor[p] = {};
    cursor = cursor[p] as Record<string, Json>;
  }
  cursor[parts[parts.length - 1]!] = value;
}

function stateArray(state: Record<string, Json>, path: string): Json[] {
  const value = getPath({ state }, path);
  if (!Array.isArray(value)) throw new Error(`${path} is not an array`);
  return value as Json[];
}

export function applyEffects(
  state: Record<string, Json>,
  effects: readonly Record<string, Json>[],
  env: Record<string, unknown>,
): Record<string, Json> {
  const next = JSON.parse(JSON.stringify(state)) as Record<string, Json>;
  const fullEnv = { ...env, state: next };
  for (const raw of effects) {
    const op = String(raw['op'] ?? '');
    const path = String(raw['path'] ?? '');
    if (!path.startsWith('$state.')) throw new Error(`effect path must begin $state.: ${path}`);
    if (op === 'set') {
      setPath(next, path, resolveValue(raw['value'], fullEnv) as Json);
      continue;
    }
    if (op === 'appendUnique') {
      const arr = stateArray(next, path);
      const value = resolveValue(raw['value'], fullEnv) as Json;
      const by = asString(raw['by']);
      const duplicate = by && isRecord(value)
        ? arr.some(x => isRecord(x) && jsonEqual(x[by], value[by]))
        : arr.some(x => jsonEqual(x, value));
      if (!duplicate) arr.push(value);
      continue;
    }
    if (op === 'updateAllWhere') {
      const arr = stateArray(next, path);
      const patch = asRecord(raw['set']);
      if (!patch) throw new Error('updateAllWhere requires an object set');
      for (let i = 0; i < arr.length; i++) {
        const item = arr[i];
        if (!isRecord(item) || !matchesWhere(item, raw['where'], fullEnv)) continue;
        arr[i] = { ...item, ...resolveValue(patch, { ...fullEnv, item }) as Record<string, Json> };
      }
      continue;
    }
    throw new Error(`unsupported effect operator: ${op || '(missing)'}`);
  }
  return next;
}

export function validateActionPayload(action: ApplicationAction, payload: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const declared = new Set((action.inputs ?? []).map(i => i.name));
  for (const key of Object.keys(payload)) if (!declared.has(key)) errors.push(`undeclared input: ${key}`);
  for (const input of action.inputs ?? []) {
    const value = payload[input.name];
    if (input.required && (value === undefined || value === null || value === '')) {
      errors.push(`${input.name} is required`); continue;
    }
    if (value === undefined || value === null) continue;
    if (input.type === 'string' || input.type === 'iri') {
      if (typeof value !== 'string') errors.push(`${input.name} must be a string`);
      if (input.type === 'iri' && typeof value === 'string' && !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) errors.push(`${input.name} must be an absolute IRI`);
    } else if (input.type === 'number' && typeof value !== 'number') errors.push(`${input.name} must be a number`);
    else if (input.type === 'boolean' && typeof value !== 'boolean') errors.push(`${input.name} must be a boolean`);
    if (input.options && !input.options.some(o => jsonEqual(o, value))) errors.push(`${input.name} is not one of the declared options`);
  }
  return errors;
}

function asContract(doc: Record<string, Json>): ApplicationContract {
  if (typeof doc['schema'] !== 'string' || !String(doc['schema']).startsWith('interego.application.contract/')) throw new Error('contract schema is not interego.application.contract/*');
  if (typeof doc['applicationId'] !== 'string' || !Array.isArray(doc['actions'])) throw new Error('contract lacks applicationId/actions');
  for (const a of doc['actions']) if (!isRecord(a) || typeof a['actionIri'] !== 'string') throw new Error('contract has a malformed action');
  return doc as unknown as ApplicationContract;
}

function asDefinition(doc: Record<string, Json>): ApplicationDefinition {
  if (typeof doc['schema'] !== 'string' || !String(doc['schema']).startsWith('interego.application.definition/')) throw new Error('definition schema is not interego.application.definition/*');
  if (typeof doc['id'] !== 'string' || typeof doc['stateGraphIri'] !== 'string' || typeof doc['contractGraphIri'] !== 'string') throw new Error('definition lacks id/stateGraphIri/contractGraphIri');
  return doc as unknown as ApplicationDefinition;
}

function asState(doc: Record<string, Json>): ApplicationState {
  if (typeof doc['schema'] !== 'string' || !String(doc['schema']).startsWith('interego.application.state/')) throw new Error('state schema is not interego.application.state/*');
  if (typeof doc['applicationId'] !== 'string' || typeof doc['version'] !== 'number' || !isRecord(doc['data'])) throw new Error('state lacks applicationId/version/data');
  return doc as unknown as ApplicationState;
}

function contractRefFromGovernance(doc: Record<string, Json>, applicationId: string): { descriptorUrl?: string; graphIri?: string; digest?: string; cid?: string; definitionDescriptorUrl?: string; definitionDigest?: string; definitionCid?: string; definitionGraphIri?: string } | null {
  const data = asRecord(doc['data']);
  if (!data) return null;
  const active = asRecord(data['activeEpoch']) ?? asRecord(data['activeContract']);
  if (!active) return null;
  const appliesTo = asString(active['applicationId']) ?? asString(data['targetApplicationId']);
  if (appliesTo && appliesTo !== applicationId) return null;
  return {
    descriptorUrl: asString(active['contractDescriptorUrl']) ?? asString(active['descriptorUrl']),
    graphIri: asString(active['contractGraphIri']) ?? asString(active['graphIri']),
    digest: asString(active['contractDigest']) ?? asString(active['documentDigest']),
    cid: asString(active['contractCid']) ?? asString(active['cid']),
    definitionDescriptorUrl: asString(active['definitionDescriptorUrl']),
    definitionDigest: asString(active['definitionDigest']),
    definitionCid: asString(active['definitionCid']),
    definitionGraphIri: asString(active['definitionGraphIri']),
  };
}

function actionView(contract: ApplicationContract, state: ApplicationState, actor: string | undefined, forked: boolean): Record<string, Json>[] {
  return contract.actions.map(a => {
    const guard = evaluateGuard(a.guard, { state: state.data, payload: {}, actor: actor ?? '', now: new Date().toISOString() });
    const guardDeferred = canonicalJson(a.guard ?? true).includes('$payload');
    const executable = !forked
      && descriptorActionIsExecutable(a)
      && guard.supported
      && (guardDeferred || guard.pass)
      && (a.method?.toUpperCase() === 'GET' || !!actor);
    return {
      actionIri: a.actionIri,
      label: a.label ?? a.actionIri,
      description: a.description ?? '',
      method: a.method ?? 'POST',
      target: a.target ?? '',
      goal: a.goal ?? '',
      inputs: (a.inputs ?? []) as unknown as Json,
      guard: (a.guard ?? true) as Json,
      guardPass: guard.pass,
      guardDeferred,
      guardSupported: guard.supported,
      guardExplanation: guard.explanation,
      executable,
      disabledReason: executable ? '' : forked ? 'state chain is forked' : !descriptorActionIsExecutable(a) ? 'unsupported runtime or method' : !guard.supported ? 'guard operator is unsupported' : !guardDeferred && !guard.pass ? 'guard does not pass' : 'authenticated actor required',
    };
  });
}

export function descriptorActionIsExecutable(action: ApplicationAction): boolean {
  const method = (action.method ?? 'POST').toUpperCase();
  return action.target === SIGNED_DOMAIN_RUNTIME && (method === 'GET' || method === 'POST');
}

function receiptOf(state: ApplicationState): Record<string, Json> | undefined {
  return asRecord(asRecord(state.transition)?.['receipt']);
}

export function verifyReplay(
  history: readonly { entry: LabManifestEntry; descriptor: LabDescriptor; envelope: SignedJsonEnvelope; state: ApplicationState }[],
  contractsByDigest: ReadonlyMap<string, { descriptor: LabDescriptor; envelope: SignedJsonEnvelope; contract: ApplicationContract }>,
): ReplayReport {
  const sorted = [...history].sort((a, b) => a.state.version - b.state.version || a.entry.descriptorUrl.localeCompare(b.entry.descriptorUrl));
  const links: ReplayLink[] = [];
  const globalErrors: string[] = [];
  const epochs = new Map<string, { digest: string; version?: string; descriptorUrl: string; links: number }>();
  let previous: typeof sorted[number] | undefined;
  for (let index = 0; index < sorted.length; index++) {
    const item = sorted[index]!;
    const errors: string[] = [];
    const trusted = descriptorTrusted(item.descriptor, item.envelope);
    if (!trusted) errors.push('descriptor trust binding failed');
    if (!item.envelope.digestVerified) errors.push('payload digest mismatch');
    if (item.entry.cid && item.descriptor.cid && item.entry.cid !== item.descriptor.cid) errors.push('manifest CID does not address the fetched descriptor bytes');
    let receiptVerified = index === 0;
    let priorVerified = index === 0;
    let guardVerified = index === 0;
    let effectVerified = index === 0;
    let actionIri: string | undefined;
    let actor: string | undefined;
    let at: string | undefined;
    let contractDigest: string | undefined;
    let contractVersion: string | undefined;
    if (index === 0) {
      if (item.state.version !== 0) errors.push('genesis version is not 0');
      if (item.state.transition) errors.push('genesis unexpectedly carries a transition');
    } else if (previous) {
      const transition = asRecord(item.state.transition);
      const prior = asRecord(transition?.['prior']);
      const receipt = asRecord(transition?.['receipt']);
      if (!transition || !prior || !receipt) {
        errors.push('transition/prior/receipt missing');
      } else {
        actionIri = asString(receipt['actionIri']) ?? asString(transition['actionIri']);
        actor = asString(receipt['actor']);
        at = asString(receipt['at']) ?? asString(transition['at']);
        contractDigest = asString(receipt['contractDigest']);
        priorVerified = item.state.version === previous.state.version + 1
          && prior['descriptorUrl'] === previous.entry.descriptorUrl
          && (!!previous.entry.cid && prior['cid'] === previous.entry.cid)
          && receipt['expectedHead'] === previous.entry.cid
          && receipt['stateVersion'] === previous.state.version;
        if (!priorVerified) errors.push('prior/CAS/version linkage failed');
        const declaredReceiptDigest = asString(transition['receiptDigest']);
        receiptVerified = !!declaredReceiptDigest && declaredReceiptDigest === sha256Hex(canonicalJson(receipt));
        if (!receiptVerified) errors.push('receipt digest mismatch');
        const epoch = contractDigest ? contractsByDigest.get(contractDigest) : undefined;
        if (!epoch) {
          errors.push('receipt-bound contract is unavailable');
        } else {
          contractVersion = asString(epoch.contract['version']);
          const action = epoch.contract.actions.find(a => a.actionIri === actionIri);
          if (!descriptorTrusted(epoch.descriptor, epoch.envelope)) errors.push('receipt-bound contract is not fully verified');
          if (receipt['descriptorUrl'] !== epoch.descriptor.url || epoch.envelope.declaredDigest !== contractDigest) errors.push('receipt contract binding failed');
          if (!action) {
            errors.push('receipt action is absent from bound contract');
          } else {
            const payload = asRecord(receipt['payload']) ?? {};
            const guard = evaluateGuard(action.guard, { state: previous.state.data, payload, actor: actor ?? '', now: at ?? '' });
            guardVerified = guard.supported && guard.pass;
            if (!guardVerified) errors.push(`guard replay failed: ${guard.explanation}`);
            try {
              const replayed = applyEffects(previous.state.data, action.effects ?? [], { payload, actor: actor ?? '', now: at ?? '' });
              effectVerified = jsonEqual(replayed, item.state.data);
              if (!effectVerified) errors.push('effect replay did not reproduce successor data');
            } catch (err) {
              effectVerified = false;
              errors.push(`effect replay failed: ${(err as Error).message}`);
            }
          }
          const old = epochs.get(contractDigest!);
          epochs.set(contractDigest!, {
            digest: contractDigest!, version: contractVersion, descriptorUrl: epoch.descriptor.url,
            links: (old?.links ?? 0) + 1,
          });
        }
      }
    }
    const verified = errors.length === 0 && trusted && item.envelope.digestVerified && receiptVerified && priorVerified && guardVerified && effectVerified;
    links.push({
      index,
      version: item.state.version,
      descriptorUrl: item.entry.descriptorUrl,
      ...(item.entry.cid !== undefined ? { cid: item.entry.cid } : {}),
      ...(actionIri ? { actionIri } : {}),
      ...(actor ? { actor } : {}),
      ...(at ? { at } : {}),
      ...(contractDigest ? { contractDigest } : {}),
      ...(contractVersion ? { contractVersion } : {}),
      trusted,
      digestVerified: item.envelope.digestVerified,
      receiptVerified,
      priorVerified,
      guardVerified,
      effectVerified,
      verified,
      errors,
    });
    previous = item;
  }
  if (sorted.length === 0) globalErrors.push('state history is empty');
  const verifiedLinks = links.filter(l => l.verified).length;
  return {
    complete: links.length > 0 && verifiedLinks === links.length,
    chainLength: links.length,
    transitions: Math.max(0, links.length - 1),
    verifiedLinks,
    contractEpochs: [...epochs.values()],
    links,
    errors: globalErrors,
  };
}

async function loadEnvelope(reads: ApplicationLabReads, url: string): Promise<{ descriptor: LabDescriptor; envelope: SignedJsonEnvelope }> {
  const descriptor = await reads.descriptor(url);
  return { descriptor, envelope: parseSignedJsonDocument(descriptorPayload(descriptor)) };
}

/** Resolve and verify one live application from blind catalog discovery. */
export async function resolveApplicationLab(input: ResolveApplicationLabInput, reads: ApplicationLabReads): Promise<ResolvedApplicationLab> {
  const catalogGraphIri = input.catalogGraphIri ?? DEFAULT_CATALOG_IRI;
  let podUrl = input.podUrl;
  let catalogDescriptorUrl = input.catalogDescriptorUrl;
  let catalogCandidates: readonly { podUrl: string; entry: LabManifestEntry }[] = [];
  if (!catalogDescriptorUrl) {
    if (podUrl) {
      const head = await reads.currentHead(podUrl, catalogGraphIri);
      if (head.forked) throw new Error(`application catalog is forked on ${podUrl}`);
      catalogDescriptorUrl = head.head?.descriptorUrl ?? undefined;
    } else {
      catalogCandidates = await reads.discoverCatalogs(catalogGraphIri);
      // Discovery order is not authority. Verify candidates, then choose the newest
      // fully bound catalog deterministically. The complete candidate list is exposed.
      const sorted = [...catalogCandidates].sort((a, b) => String(b.entry.validFrom ?? '').localeCompare(String(a.entry.validFrom ?? '')) || a.entry.descriptorUrl.localeCompare(b.entry.descriptorUrl));
      for (const candidate of sorted) {
        try {
          const loaded = await loadEnvelope(reads, candidate.entry.descriptorUrl);
          if (descriptorTrusted(loaded.descriptor, loaded.envelope)) {
            catalogDescriptorUrl = candidate.entry.descriptorUrl;
            podUrl = candidate.podUrl;
            break;
          }
        } catch { /* malformed/unreachable candidate is not authoritative */ }
      }
    }
  }
  if (!catalogDescriptorUrl) throw new Error(`no verified application catalog discovered for ${catalogGraphIri}`);
  podUrl ??= podFromDescriptorUrl(catalogDescriptorUrl);

  const { descriptor: catalogDescriptor, envelope: catalogEnvelope } = await loadEnvelope(reads, catalogDescriptorUrl);
  if (!descriptorTrusted(catalogDescriptor, catalogEnvelope)) throw new Error('selected application catalog is not cryptographically and descriptor bound');
  const catalogHead = await reads.currentHead(podUrl, catalogGraphIri);
  if (catalogHead.forked) throw new Error(`application catalog is forked on ${podUrl}`);
  const catalogCurrent = catalogHead.head?.descriptorUrl === catalogDescriptorUrl;
  if (catalogCurrent && catalogHead.head?.cid && catalogDescriptor.cid && catalogHead.head.cid !== catalogDescriptor.cid) throw new Error('catalog head CID does not address the fetched descriptor bytes');
  const catalog = catalogEnvelope.document;
  if (typeof catalog['schema'] !== 'string' || !String(catalog['schema']).startsWith('interego.application.catalog/')) throw new Error('selected document is not an application catalog');
  const applications = Array.isArray(catalog['applications']) ? catalog['applications'].filter(isRecord) : [];
  if (applications.length === 0) throw new Error('verified catalog contains no applications');
  const catalogEntry = (input.applicationId ? applications.find(a => a['applicationId'] === input.applicationId) : applications[0]);
  if (!catalogEntry) throw new Error(`application is not present in verified catalog: ${input.applicationId}`);
  const applicationId = asString(catalogEntry['applicationId']);
  if (!applicationId) throw new Error('catalog application entry has no applicationId');

  const baseContractRef = artifactRef(catalogEntry, 'contract');
  const definitionRef = artifactRef(catalogEntry, 'definition');
  const baseContractUrl = asString(baseContractRef?.['descriptorUrl']);
  let definitionUrl = asString(catalogEntry['definitionDescriptorUrl']) ?? asString(definitionRef?.['descriptorUrl']);
  if (!baseContractUrl || !definitionUrl) throw new Error('catalog entry does not pin contract and definition descriptors');

  // Optional governance is itself just another signed state graph.  If present,
  // its activeEpoch pointer selects the current contract/definition; no application
  // name or upgrade policy is hardcoded into the Lab.
  let activeContractUrl = baseContractUrl;
  let governance: Record<string, Json> | null = null;
  let governanceEvidence: ArtifactEvidence | null = null;
  let activeGovernanceRef: ReturnType<typeof contractRefFromGovernance> = null;
  const governanceGraphIri = asString(catalogEntry['governanceStateGraphIri'])
    ?? asString(asRecord(catalogEntry['governance'])?.['stateGraphIri']);
  if (governanceGraphIri) {
    const gh = await reads.currentHead(podUrl, governanceGraphIri);
    if (gh.forked) throw new Error(`application governance is forked: ${governanceGraphIri}`);
    if (!gh.head?.descriptorUrl) throw new Error(`application governance has no singular head: ${governanceGraphIri}`);
    const loaded = await loadEnvelope(reads, gh.head.descriptorUrl);
    governanceEvidence = evidence('governance-head', loaded.descriptor, loaded.envelope, gh.head.cid);
    if (!governanceEvidence.trusted) throw new Error('application governance head is not fully verified');
    governance = loaded.envelope.document;
    activeGovernanceRef = contractRefFromGovernance(governance, applicationId);
    if (!activeGovernanceRef?.descriptorUrl
      || !activeGovernanceRef.graphIri
      || !activeGovernanceRef.digest
      || !activeGovernanceRef.cid
      || !activeGovernanceRef.definitionDescriptorUrl
      || !activeGovernanceRef.definitionGraphIri
      || !activeGovernanceRef.definitionDigest
      || !activeGovernanceRef.definitionCid) {
      throw new Error('verified governance head does not fully pin its active contract and definition epoch');
    }
    activeContractUrl = activeGovernanceRef.descriptorUrl;
    definitionUrl = activeGovernanceRef.definitionDescriptorUrl;
  }

  const [definitionLoaded, activeContractLoaded] = await Promise.all([
    loadEnvelope(reads, definitionUrl),
    loadEnvelope(reads, activeContractUrl),
  ]);
  const definition = asDefinition(definitionLoaded.envelope.document);
  const activeContract = asContract(activeContractLoaded.envelope.document);
  if (!descriptorTrusted(definitionLoaded.descriptor, definitionLoaded.envelope)) throw new Error('application definition is not fully verified');
  if (!descriptorTrusted(activeContractLoaded.descriptor, activeContractLoaded.envelope)) throw new Error('active application contract is not fully verified');
  if (definition.id !== applicationId || activeContract.applicationId !== applicationId) throw new Error('catalog/definition/contract application IDs disagree');
  if (definitionRef?.['documentDigest'] && definitionRef['documentDigest'] !== definitionLoaded.envelope.declaredDigest && !governance) throw new Error('catalog-pinned definition digest does not match the fetched definition');
  if (definitionRef?.['cid'] && definitionLoaded.descriptor.cid && definitionRef['cid'] !== definitionLoaded.descriptor.cid && !governance) throw new Error('catalog-pinned definition CID does not match the fetched definition');
  if (activeGovernanceRef) {
    if (activeGovernanceRef.graphIri !== activeContractLoaded.envelope.graphIri) throw new Error('governance-pinned active contract graph does not match the fetched contract');
    if (activeGovernanceRef.digest !== activeContractLoaded.envelope.declaredDigest) throw new Error('governance-pinned active contract digest does not match the fetched contract');
    if (activeGovernanceRef.cid !== activeContractLoaded.descriptor.cid) throw new Error('governance-pinned active contract CID does not match the fetched contract');
    if (activeGovernanceRef.definitionDescriptorUrl !== definitionLoaded.descriptor.url) throw new Error('governance-pinned active definition URL does not match the fetched definition');
    if (activeGovernanceRef.definitionGraphIri !== definitionLoaded.envelope.graphIri) throw new Error('governance-pinned active definition graph does not match the fetched definition');
    if (activeGovernanceRef.definitionDigest !== definitionLoaded.envelope.declaredDigest) throw new Error('governance-pinned active definition digest does not match the fetched definition');
    if (activeGovernanceRef.definitionCid !== definitionLoaded.descriptor.cid) throw new Error('governance-pinned active definition CID does not match the fetched definition');
  }

  const stateGraphIri = asString(catalogEntry['stateGraphIri']) ?? definition.stateGraphIri;
  if (stateGraphIri !== definition.stateGraphIri) throw new Error('catalog and definition state graph IRIs disagree');
  const stateHeadResult = await reads.currentHead(podUrl, stateGraphIri);
  if (stateHeadResult.forked) {
    const forkHeads = (stateHeadResult.heads ?? []).map(h => ({ descriptorUrl: h.descriptorUrl ?? '', cid: h.cid ?? '' })) as unknown as Json;
    throw new Error(`application state is forked: ${JSON.stringify(forkHeads)}`);
  }
  const stateHeadUrl = stateHeadResult.head?.descriptorUrl;
  const stateHeadCid = stateHeadResult.head?.cid;
  if (!stateHeadUrl || !stateHeadCid) throw new Error(`application state has no singular current head: ${stateHeadResult.message ?? stateGraphIri}`);
  const stateLoaded = await loadEnvelope(reads, stateHeadUrl);
  const state = asState(stateLoaded.envelope.document);
  if (!descriptorTrusted(stateLoaded.descriptor, stateLoaded.envelope)) throw new Error('current application state is not fully verified');
  if (stateLoaded.descriptor.cid && stateLoaded.descriptor.cid !== stateHeadCid) throw new Error('state head CID does not address the fetched descriptor bytes');
  if (state.applicationId !== applicationId) throw new Error('state belongs to a different application');

  const historyEntries = await reads.discoverGraph(podUrl, stateGraphIri);
  const historyLoaded = await Promise.all(historyEntries.map(async entry => {
    const loaded = entry.descriptorUrl === stateHeadUrl ? stateLoaded : await loadEnvelope(reads, entry.descriptorUrl);
    return { entry: { ...entry, cid: entry.cid ?? loaded.descriptor.cid }, ...loaded, state: asState(loaded.envelope.document) };
  }));
  const contractUrls = new Set<string>([activeContractUrl, baseContractUrl]);
  for (const h of historyLoaded) {
    const u = asString(receiptOf(h.state)?.['descriptorUrl']);
    if (u) contractUrls.add(u);
  }
  const contractsByDigest = new Map<string, { descriptor: LabDescriptor; envelope: SignedJsonEnvelope; contract: ApplicationContract }>();
  await Promise.all([...contractUrls].map(async url => {
    const loaded = url === activeContractUrl ? activeContractLoaded : await loadEnvelope(reads, url);
    const contract = asContract(loaded.envelope.document);
    contractsByDigest.set(loaded.envelope.declaredDigest, { ...loaded, contract });
  }));
  const baseContractLoaded = [...contractsByDigest.values()].find(c => c.descriptor.url === baseContractUrl);
  if (!baseContractLoaded) throw new Error('catalog-pinned base contract could not be resolved');
  if (baseContractRef?.['documentDigest'] && baseContractRef['documentDigest'] !== baseContractLoaded.envelope.declaredDigest) throw new Error('catalog-pinned base contract digest does not match the fetched contract');
  if (baseContractRef?.['cid'] && baseContractLoaded.descriptor.cid && baseContractRef['cid'] !== baseContractLoaded.descriptor.cid) throw new Error('catalog-pinned base contract CID does not match the fetched contract');
  const replay = verifyReplay(historyLoaded, contractsByDigest);

  const genesis = [...historyLoaded].sort((a, b) => a.state.version - b.state.version)[0];
  const genesisRef = artifactRef(catalogEntry, 'genesisState');
  if (genesisRef?.['descriptorUrl'] && genesisRef['descriptorUrl'] !== genesis?.entry.descriptorUrl) throw new Error('catalog-pinned genesis descriptor is not the replay genesis');
  if (genesisRef?.['documentDigest'] && genesisRef['documentDigest'] !== genesis?.envelope.declaredDigest) throw new Error('catalog-pinned genesis digest does not match replay genesis');
  if (genesisRef?.['cid'] && genesis?.entry.cid && genesisRef['cid'] !== genesis.entry.cid) throw new Error('catalog-pinned genesis CID does not match replay genesis');
  const activeContractHead = await reads.currentHead(podUrl, activeContractLoaded.envelope.graphIri ?? definition.contractGraphIri).catch((): LabHead => ({}));
  const definitionHead = await reads.currentHead(podUrl, definitionLoaded.envelope.graphIri ?? asString(catalogEntry['definitionGraphIri']) ?? definition.id).catch((): LabHead => ({}));
  const evidences: ArtifactEvidence[] = [
    evidence('catalog', catalogDescriptor, catalogEnvelope, catalogCandidates.find(c => c.entry.descriptorUrl === catalogDescriptorUrl)?.entry.cid ?? catalogDescriptor.cid),
    evidence('definition', definitionLoaded.descriptor, definitionLoaded.envelope, definitionHead.head?.cid ?? definitionRef?.['cid'] as string | undefined),
    evidence('active-contract', activeContractLoaded.descriptor, activeContractLoaded.envelope, activeContractHead.head?.cid ?? baseContractRef?.['cid'] as string | undefined),
    evidence('state-head', stateLoaded.descriptor, stateLoaded.envelope, stateHeadCid),
    ...(governanceEvidence ? [governanceEvidence] : []),
  ];
  const manifestChecks = {
    contract: {
      descriptorUrl: activeContractUrl,
      descriptorMatch: activeGovernanceRef ? activeGovernanceRef.descriptorUrl === activeContractUrl : baseContractRef?.['descriptorUrl'] === baseContractUrl,
      digestMatch: activeGovernanceRef ? activeGovernanceRef.digest === activeContractLoaded.envelope.declaredDigest : !baseContractRef?.['documentDigest'] || baseContractRef['documentDigest'] === baseContractLoaded.envelope.declaredDigest,
      cidMatch: activeGovernanceRef ? activeGovernanceRef.cid === activeContractLoaded.descriptor.cid : !baseContractRef?.['cid'] || !baseContractLoaded.descriptor.cid || baseContractRef['cid'] === baseContractLoaded.descriptor.cid,
    },
    definition: {
      descriptorUrl: definitionUrl,
      descriptorMatch: activeGovernanceRef ? activeGovernanceRef.definitionDescriptorUrl === definitionUrl : definitionRef?.['descriptorUrl'] === definitionUrl,
      digestMatch: activeGovernanceRef ? activeGovernanceRef.definitionDigest === definitionLoaded.envelope.declaredDigest : !definitionRef?.['documentDigest'] || definitionRef['documentDigest'] === definitionLoaded.envelope.declaredDigest,
      cidMatch: activeGovernanceRef ? activeGovernanceRef.definitionCid === definitionLoaded.descriptor.cid : !definitionRef?.['cid'] || !definitionLoaded.descriptor.cid || definitionRef['cid'] === definitionLoaded.descriptor.cid,
    },
    genesisState: {
      descriptorUrl: genesis?.entry.descriptorUrl ?? '',
      descriptorMatch: !genesisRef?.['descriptorUrl'] || genesisRef['descriptorUrl'] === genesis?.entry.descriptorUrl,
      digestMatch: !genesisRef?.['documentDigest'] || genesisRef['documentDigest'] === genesis?.envelope.declaredDigest,
      cidMatch: !genesisRef?.['cid'] || !genesis?.entry.cid || genesisRef['cid'] === genesis.entry.cid,
    },
  };

  const snapshot: Record<string, Json> = {
    kind: 'interego.application-lab/v1',
    live: true,
    generatedAt: new Date().toISOString(),
    catalog: {
      graphIri: catalogGraphIri,
      descriptorUrl: catalogDescriptorUrl,
      podUrl,
      current: catalogCurrent,
      candidates: (catalogCandidates.length ? catalogCandidates : [{ podUrl, entry: { descriptorUrl: catalogDescriptorUrl } }]).map(c => ({ podUrl: c.podUrl, descriptorUrl: c.entry.descriptorUrl, cid: c.entry.cid ?? '', validFrom: c.entry.validFrom ?? '' })),
      applications: applications.map(a => ({ applicationId: a['applicationId'] ?? '', title: a['title'] ?? a['applicationId'] ?? '', version: a['version'] ?? '' })),
    },
    application: {
      applicationId,
      title: definition.title ?? asString(catalogEntry['title']) ?? applicationId,
      description: definition.description ?? '',
      version: activeContract.version ?? asString(catalogEntry['version']) ?? '',
      definition: definition as unknown as Json,
      stateGraphIri,
      contractGraphIri: activeContractLoaded.envelope.graphIri ?? definition.contractGraphIri,
      governanceGraphIri: governanceGraphIri ?? '',
    },
    head: {
      descriptorUrl: stateHeadUrl,
      cid: stateHeadCid,
      version: state.version,
      state: state.data,
      documentDigest: stateLoaded.envelope.declaredDigest,
      forked: false,
    },
    actions: actionView(activeContract, state, input.actor, false),
    replay: replay as unknown as Json,
    provenance: evidences as unknown as Json,
    manifestChecks: manifestChecks as unknown as Json,
    governance: governance ?? null,
    trust: {
      verified: catalogCurrent && evidences.every(e => e.trusted) && replay.complete,
      artifactsVerified: evidences.filter(e => e.trusted).length,
      artifactsTotal: evidences.length,
      replayComplete: replay.complete,
    },
  };

  return {
    snapshot,
    podUrl,
    catalogCurrent,
    catalogDescriptor,
    catalogEnvelope,
    catalogEntry,
    definitionDescriptor: definitionLoaded.descriptor,
    definitionEnvelope: definitionLoaded.envelope,
    definition,
    activeContractDescriptor: activeContractLoaded.descriptor,
    activeContractEnvelope: activeContractLoaded.envelope,
    activeContract,
    stateHead: { descriptorUrl: stateHeadUrl, cid: stateHeadCid },
    stateDescriptor: stateLoaded.descriptor,
    stateEnvelope: stateLoaded.envelope,
    state,
    replay,
  };
}

export interface PrepareActionInput {
  readonly actionIri: string;
  readonly payload?: Record<string, unknown>;
  readonly actor: string;
  readonly now: string;
  readonly expectedHead?: string;
}

/** Re-resolve first, then prepare the one exact descriptor-bound successor. */
export function prepareApplicationAction(resolved: ResolvedApplicationLab, input: PrepareActionInput): {
  readonly action: ApplicationAction;
  readonly successor: ApplicationState;
  readonly graphContent: string;
  readonly receipt: Record<string, Json>;
  readonly receiptDigest: string;
} {
  if (!resolved.catalogCurrent) throw new Error('selected catalog is not the current authoritative catalog head; refusing mutation');
  if (!resolved.replay.complete) throw new Error('complete replay is not verified; refusing mutation');
  if (input.expectedHead && input.expectedHead !== resolved.stateHead.cid) throw new Error(`stale application head: expected ${input.expectedHead}, observed ${resolved.stateHead.cid}`);
  const action = resolved.activeContract.actions.find(a => a.actionIri === input.actionIri);
  if (!action) throw new Error(`action is absent from the verified active contract: ${input.actionIri}`);
  if (!descriptorActionIsExecutable(action)) throw new Error(`action target/method is not executable by signed-domain/v1: ${action.target} ${action.method}`);
  if ((action.method ?? 'POST').toUpperCase() === 'GET') throw new Error('read-only actions refresh the Lab; they do not publish a successor');
  const payload = input.payload ?? {};
  const payloadErrors = validateActionPayload(action, payload);
  if (payloadErrors.length) throw new Error(`payload does not conform to the signed action inputs: ${payloadErrors.join('; ')}`);
  const guard = evaluateGuard(action.guard, { state: resolved.state.data, payload, actor: input.actor, now: input.now });
  if (!guard.supported || !guard.pass) throw new Error(`signed action guard refused: ${guard.explanation}`);
  const nextData = applyEffects(resolved.state.data, action.effects ?? [], { payload, actor: input.actor, now: input.now });
  const receipt: Record<string, Json> = {
    actionIri: action.actionIri,
    actor: input.actor,
    applicationId: resolved.state.applicationId,
    at: input.now,
    contractDigest: resolved.activeContractEnvelope.declaredDigest,
    descriptorUrl: resolved.activeContractDescriptor.url,
    expectedHead: resolved.stateHead.cid,
    goal: action.goal ?? '',
    payload: payload as unknown as Json,
    stateVersion: resolved.state.version,
    version: 1,
  };
  const receiptDigest = sha256Hex(canonicalJson(receipt));
  const successor: ApplicationState = {
    applicationId: resolved.state.applicationId,
    data: nextData,
    schema: resolved.state.schema,
    transition: {
      actionIri: action.actionIri,
      at: input.now,
      prior: { cid: resolved.stateHead.cid, descriptorUrl: resolved.stateHead.descriptorUrl },
      receipt,
      receiptDigest,
    },
    version: resolved.state.version + 1,
  };
  const signed = signedJsonGraph(resolved.definition.stateGraphIri, 'application-state', successor as unknown as Record<string, Json>);
  return { action, successor, graphContent: signed.graphContent, receipt, receiptDigest };
}
