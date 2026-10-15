/**
 * Current capability contracts and bounded, explicit examples for the I2IDL-X workbench.
 * A manifest read is not an execution proof. Protected/stateful calls are prepared only.
 */
import type { Express, Response as ExpressResponse } from 'express';
import { actionUrl } from '@interego/core';
import { affordanceToMcpToolSchema, type Affordance } from '../../_shared/affordance-mcp/index.js';

type Row = Record<string, unknown>;
export interface CapabilityAnnotation {
  implementation: 'implemented' | 'not-implemented';
  mode: string;
  authorization: string;
  requires: readonly string[];
  notes: readonly string[];
  example?: { arguments: Row; label: string };
  signing?: { schema: Row; payload: Row; instructions: readonly string[] };
}
export interface CapabilityDirectoryConfig {
  baseUrl: string;
  foxxiAffordances: readonly Affordance[];
  fetch: typeof fetch;
  build?: string;
  annotations?: Readonly<Record<string, CapabilityAnnotation>>;
}
export interface DirectoryAction {
  iri: string; sys: 'foxxi' | 'telemetry' | 'relay'; n: string; t: string; d: string;
  m: string; u: string; mt: string; in: Row[]; ro: boolean | null;
  de: boolean | null; ix: boolean | null; xr: boolean;
  auth: string; classification: string; requirements: string[]; notes: string[];
  input_schema: Row | null;
  signing?: { schema: Row; payload: Row; instructions: readonly string[] };
  execution: { mode: 'public-example' | 'client-required' | 'prepare-only' | 'client-only' | 'unavailable'; reason: string; implemented: boolean; side_effects: string[] };
  example: { payload: Row; label: string; provenance: 'example'; warning: string };
}
export interface CapabilityDirectory {
  schema: 1; audience: string; build: string; generated_at: string; complete: boolean;
  sources: { system: string; url: string; status: string; checked_at: string; count: number; error?: string }[];
  actions: DirectoryAction[];
}
interface Profile { path: string; method: 'GET' | 'POST'; payload: Row; label: string; task?: boolean; check: (payload: Row) => boolean }
const RELAY = 'https://relay.interego.xwisee.com';
const CATALOG = RELAY + '/.well-known/operations';
const MAX_INPUT = 64_000, MAX_OUTPUT = 2_000_000, CACHE_MS = 60_000;
const CLIENT_VALUE = '<provided by your connected client>';
const secretKey = (key: string) => {
  const name = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return name === 'key' || /privatekey|privkey|password|passwd|mnemonic|seed|secret|apikey|authorization|authheader|bearer|token|signature|signedpayload/.test(name);
};
const placeholder = (v: unknown) => v === CLIENT_VALUE;
function carriesSecrets(v: unknown, allowPlaceholder: boolean): boolean {
  if (Array.isArray(v)) return v.some(value => carriesSecrets(value, allowPlaceholder));
  if (!object(v)) return typeof v === 'string' && (/\bBearer\s+\S+/i.test(v) || (!allowPlaceholder && v === CLIENT_VALUE));
  return Object.entries(v).some(([key, value]) => secretKey(key) ? !(allowPlaceholder && placeholder(value)) : carriesSecrets(value, allowPlaceholder));
}
const object = (v: unknown): v is Row => !!v && typeof v === 'object' && !Array.isArray(v);
const asText = (v: unknown): string => typeof v === 'string' ? v : '';
const list = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
const strings = (v: unknown): string[] => list(v).filter((x): x is string => typeof x === 'string');
const allowedKeys = (p: Row, names: readonly string[]) => Object.keys(p).every(k => names.includes(k));
function redactedExample(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(redactedExample);
  if (!object(v)) return typeof v === 'string' && /\bBearer\s+\S+/i.test(v) ? CLIENT_VALUE : v;
  return Object.fromEntries(Object.entries(v).map(([key, value]) => [key, secretKey(key) ? CLIENT_VALUE : redactedExample(value)]));
}
/** Keep schema contracts intact while preventing supplied example/default secrets reaching the browser. */
function publicSchema(v: unknown, property = ''): unknown {
  if (Array.isArray(v)) return v.map(x => publicSchema(x, property));
  if (!object(v)) return v;
  return Object.fromEntries(Object.entries(v).map(([key, value]) => [
    key,
    key === 'examples' ? (secretKey(property) ? list(value).map(() => CLIENT_VALUE) : redactedExample(value)) :
      key === 'default' ? (secretKey(property) ? CLIENT_VALUE : redactedExample(value)) :
        key === 'properties' && object(value) ? Object.fromEntries(Object.entries(value).map(([name, schema]) => [name, publicSchema(schema, name)])) : publicSchema(value, property),
  ]));
}
const SAMPLE_DESCRIPTOR = {
  id: 'urn:example:descriptor:source', describes: ['urn:example:graph:glossary'],
  facets: [{ type: 'Semiotic', modalStatus: 'Asserted', confidence: 0.9 }],
};
const descriptor = (v: unknown): boolean => object(v) && typeof v.id === 'string' &&
  v.id.length <= 4096 && Array.isArray(v.describes) && v.describes.length <= 64 &&
  v.describes.every(s => typeof s === 'string' && s.length <= 4096) &&
  Array.isArray(v.facets) && v.facets.length <= 64 && v.facets.every(object);
const short = (v: unknown, max: number) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const profiles: Readonly<Record<string, Profile>> = {
  'foxxi.discover_lrs': { path: '/xapi/about', method: 'GET', payload: {}, label: 'Read this deployment’s real LRS discovery document', check: p => !Object.keys(p).length },
  'foxxi.i2idlx_capabilities': { path: '/i2idlx/capabilities', method: 'GET', payload: {}, label: 'Inspect this workbench’s real connection options', check: p => !Object.keys(p).length },
  'foxxi.i2idlx_ask': { path: '/i2idlx/api/ask', method: 'POST', payload: { question: 'Which glossary concepts describe a learning record store?' }, label: 'Generate a grounded task packet for your connected model', task: true,
    check: p => allowedKeys(p, ['question', 'concept_ids']) && short(p.question, 2000) && (p.concept_ids === undefined || (Array.isArray(p.concept_ids) && p.concept_ids.length <= 14 && p.concept_ids.every(x => short(x, 200)))) },
  'foxxi.i2idlx_orchestrate': { path: '/i2idlx/api/orchestrate', method: 'POST', payload: { example: true }, label: 'Generate an unexecuted orchestration recipe for an explicitly fictional example', task: true,
    check: p => allowedKeys(p, ['example']) && p.example === true },
  'foxxi.read_intervention_methods': { path: '/performance/methods', method: 'GET', payload: {}, label: 'Read the real versioned intervention-method catalogue',
    check: p => allowedKeys(p, ['method', 'format']) && (p.method === undefined || short(p.method, 512)) && (p.format === undefined || ['jsonld', 'markdown', 'turtle'].includes(String(p.format))) },
  'foxxi.review_method_evidence': { path: '/performance/methods/review', method: 'POST', payload: { method: 'consulting', evidence: [] }, label: 'Show missing evidence against the real consulting criteria; no quality certification',
    check: p => allowedKeys(p, ['method', 'evidence']) && short(p.method, 512) && (p.evidence === undefined || (Array.isArray(p.evidence) && p.evidence.length <= 200 && p.evidence.every(e => object(e) && allowedKeys(e, ['criterion', 'artifact', 'note']) && short(e.criterion, 1024) && short(e.artifact, 2048) && short(e.note, 2000)))) },
  'foxxi.bind_decoration': { path: '/agent/decorations/bind', method: 'POST', payload: { decoration: 'lrs-x', values: { endpoint: 'https://example.org/lrs' } },
    label: 'Bind an LRS-X template to an illustrative HTTPS endpoint; no endpoint request or conformance claim',
    check: p => {
      if (!allowedKeys(p, ['decoration', 'values']) || !['lrs-x', 'lms-x'].includes(String(p.decoration)) || !object(p.values) || Object.keys(p.values).length > 16) return false;
      return Object.values(p.values).every(value => {
        if (typeof value !== 'string' || value.length > 2048) return false;
        try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.hash && !url.search; } catch { return false; }
      });
    } },
  'foxxi.resolve_aligned_competency': { path: '/foxxi/resolve_aligned_competency', method: 'POST',
    payload: { held_competency_iri: 'urn:example:competency:record-store', required_competency_iri: 'urn:example:competency:record-store', alignments: [] },
    label: 'Compute an alignment result for illustrative inline competency identifiers',
    check: p => allowedKeys(p, ['held_competency_iri', 'required_competency_iri', 'alignments']) && short(p.held_competency_iri, 4096) && short(p.required_competency_iri, 4096) && Array.isArray(p.alignments) && p.alignments.length <= 64 && p.alignments.every(object) },
  'relay.compose': { path: '/tool/compose', method: 'POST',
    payload: { descriptors: [SAMPLE_DESCRIPTOR, { id: 'urn:example:descriptor:mapping', describes: ['urn:example:graph:mapping'], facets: [{ type: 'Semiotic', modalStatus: 'Hypothetical', confidence: 0.7 }] }], operator: 'union' },
    label: 'Compose illustrative inline descriptors; no pod or lattice write',
    check: p => allowedKeys(p, ['descriptors', 'operator', 'types']) && Array.isArray(p.descriptors) && p.descriptors.length > 0 && p.descriptors.length <= 16 && p.descriptors.every(descriptor) && ['union', 'intersection', 'restriction', 'override'].includes(String(p.operator)) && (p.types === undefined || (Array.isArray(p.types) && p.types.length <= 16 && p.types.every(x => short(x, 128)))) },
  'relay.restrict': { path: '/tool/restrict', method: 'POST', payload: { descriptor: SAMPLE_DESCRIPTOR, selector: { kind: 'facet-types', types: ['Semiotic'] } },
    label: 'Project an illustrative inline descriptor onto selected facets',
    check: p => allowedKeys(p, ['descriptor', 'selector']) && descriptor(p.descriptor) && object(p.selector) && allowedKeys(p.selector, ['kind', 'types']) && p.selector.kind === 'facet-types' && Array.isArray(p.selector.types) && p.selector.types.length <= 16 && p.selector.types.every(x => short(x, 128)) },
  'relay.extend': { path: '/tool/extend', method: 'POST', payload: { part: { ...SAMPLE_DESCRIPTOR, id: 'urn:example:descriptor:part' }, whole: SAMPLE_DESCRIPTOR, preserve_witness: true },
    label: 'Extend illustrative inline descriptors and retain the witness',
    check: p => allowedKeys(p, ['part', 'whole', 'preserve_witness']) && descriptor(p.part) && descriptor(p.whole) && (p.preserve_witness === undefined || typeof p.preserve_witness === 'boolean') },
  'relay.analyze_question': { path: '/tool/analyze_question', method: 'POST', payload: { question: 'Which glossary concepts describe a learning record store?', session_content: 'The glossary includes learning record store concepts and definitions.' },
    label: 'Compute a real cognitive strategy for an illustrative question',
    check: p => allowedKeys(p, ['question', 'session_content']) && short(p.question, 2000) && (p.session_content === undefined || short(p.session_content, 16000)) },
};
function safeJson(v: unknown, depth = 0): boolean {
  if (depth > 16) return false;
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (Array.isArray(v)) return v.length <= 2000 && v.every(x => safeJson(x, depth + 1));
  return object(v) && Object.keys(v).length <= 2000 && Object.entries(v).every(([k, x]) => !['__proto__', 'prototype', 'constructor'].includes(k) && safeJson(x, depth + 1));
}
/** Supported declared constraints, never a claim about domain records, authorization or efficacy. */
export function validateDirectoryPayload(schema: Row | null, payload: unknown): { valid: boolean; errors: string[]; scope: string } {
  const errors: string[] = [];
  const add = (message: string) => { if (errors.length < 40) errors.push(message); };
  const visit = (s: unknown, value: unknown, path: string, depth: number): void => {
    if (depth > 20) { add(path + ': schema nesting exceeds capacity'); return; }
    if (s === false) { add(path + ': schema refuses this value'); return; }
    if (s === true) return;
    if (!object(s)) { add(path + ': schema is unavailable'); return; }
    if (s.$ref !== undefined) { add(path + ': reference validation is unavailable; resolve the declared schema in your client'); return; }
    if (Array.isArray(s.anyOf) && !s.anyOf.some(branch => { const before = errors.length; visit(branch, value, path, depth + 1); const pass = before === errors.length; errors.splice(before); return pass; })) add(path + ': no anyOf alternative matches');
    if (Array.isArray(s.allOf)) for (const branch of s.allOf) visit(branch, value, path, depth + 1);
    if (Array.isArray(s.oneOf)) {
      let matches = 0;
      for (const branch of s.oneOf) { const before = errors.length; visit(branch, value, path, depth + 1); if (before === errors.length) matches++; errors.splice(before); }
      if (matches !== 1) add(path + ': exactly one oneOf alternative must match');
    }
    if (s.enum !== undefined && (!Array.isArray(s.enum) || !s.enum.some(v => JSON.stringify(v) === JSON.stringify(value)))) add(path + ': value is outside the declared enum');
    if (s.const !== undefined && JSON.stringify(s.const) !== JSON.stringify(value)) add(path + ': value differs from the declared constant');
    const types = typeof s.type === 'string' ? [s.type] : strings(s.type);
    if (types.length && !types.some(t => t === 'object' ? object(value) : t === 'array' ? Array.isArray(value) : t === 'integer' ? typeof value === 'number' && Number.isSafeInteger(value) : t === 'number' ? typeof value === 'number' && Number.isFinite(value) : t === 'null' ? value === null : typeof value === t)) { add(path + ': expected ' + types.join(' or ')); return; }
    if (object(value)) {
      for (const key of strings(s.required)) if (!Object.hasOwn(value, key)) add(path + '.' + key + ': required');
      const props = object(s.properties) ? s.properties : {};
      for (const [key, child] of Object.entries(value)) {
        if (Object.hasOwn(props, key)) visit(props[key], child, path + '.' + key, depth + 1);
        else if (s.additionalProperties === false) add(path + '.' + key + ': additional property is not allowed');
        else if (object(s.additionalProperties)) visit(s.additionalProperties, child, path + '.' + key, depth + 1);
      }
    }
    if (Array.isArray(value)) {
      if (typeof s.minItems === 'number' && value.length < s.minItems) add(path + ': too few items');
      if (typeof s.maxItems === 'number' && value.length > s.maxItems) add(path + ': too many items');
      if (s.items !== undefined) value.forEach((v, i) => visit(s.items, v, path + '[' + i + ']', depth + 1));
    }
    if (typeof value === 'number') {
      if (typeof s.minimum === 'number' && value < s.minimum) add(path + ': below minimum');
      if (typeof s.maximum === 'number' && value > s.maximum) add(path + ': above maximum');
    }
    if (typeof value === 'string') {
      if (typeof s.minLength === 'number' && [...value].length < s.minLength) add(path + ': too short');
      if (typeof s.maxLength === 'number' && [...value].length > s.maxLength) add(path + ': too long');
      // Future constraints must not silently become a positive contract verdict.
      if (s.pattern !== undefined || s.format !== undefined) add(path + ': pattern/format requires the declared schema validator in your client');
    }
    const supported = new Set(['$schema', '$id', 'title', 'description', 'default', 'examples', 'type', 'enum', 'const', 'properties', 'required', 'additionalProperties', 'items', 'minItems', 'maxItems', 'minimum', 'maximum', 'minLength', 'maxLength', 'anyOf', 'allOf', 'oneOf', '$ref', 'pattern', 'format']);
    for (const key of Object.keys(s)) if (!supported.has(key)) add(path + ': unsupported schema constraint ' + key);
  };
  if (!schema) add('Current input schema is unavailable');
  else if (!object(payload) || !safeJson(payload) || Buffer.byteLength(JSON.stringify(payload), 'utf8') > MAX_INPUT) add('Arguments must be a safe JSON object within 64 KB and nesting limits');
  else visit(schema, payload, '$', 0);
  return { valid: errors.length === 0, errors, scope: 'declared-input-constraints-only; no authorization, domain-data, persistence or model-execution claim' };
}
function exampleValue(schema: unknown, name: string, depth = 0): unknown {
  if (!object(schema) || depth > 8) return null;
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  const type = typeof schema.type === 'string' ? schema.type : object(schema.properties) ? 'object' : '';
  if (type === 'object') {
    const result: Row = {}, props = object(schema.properties) ? schema.properties : {};
    const required = new Set(strings(schema.required));
    const firstAlternative = list(schema.anyOf)[0];
    if (object(firstAlternative)) strings(firstAlternative.required).forEach(k => required.add(k));
    for (const key of required) result[key] = exampleValue(props[key], key, depth + 1);
    return result;
  }
  if (type === 'array') return Array.from({ length: typeof schema.minItems === 'number' ? Math.min(8, schema.minItems) : 0 }, () => exampleValue(schema.items, name, depth + 1));
  if (type === 'boolean') return false;
  if (type === 'number' || type === 'integer') return typeof schema.minimum === 'number' ? schema.minimum : 0;
  if (type === 'string' && secretKey(name)) return CLIENT_VALUE;
  if (type === 'string') return /url|iri|uri/i.test(name) ? 'https://example.invalid/replace-with-your-authorized-resource' : 'replace-' + name;
  return null;
}
async function readText(response: globalThis.Response, max = MAX_OUTPUT): Promise<string> {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > max) throw new Error('Response exceeds capacity');
  if (!response.body) return '';
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let count = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      count += next.value.byteLength;
      if (count > max) throw new Error('Response exceeds capacity');
      chunks.push(next.value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  const bytes = new Uint8Array(count);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}
async function mapBounded<T, U>(values: readonly T[], work: (value: T) => Promise<U>): Promise<U[]> {
  const output: U[] = new Array(values.length); let index = 0;
  const finished = await Promise.allSettled(Array.from({ length: Math.min(6, values.length) }, async () => {
    while (index < values.length) { const i = index++; output[i] = await work(values[i]!); }
  }));
  const failed = finished.find(result => result.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
  return output;
}
function fields(schema: Row | null): Row[] {
  if (!schema || !object(schema.properties)) return [];
  return Object.entries(schema.properties).map(([name, value]) => {
    const p = object(value) ? value : {};
    return { n: name, req: strings(schema.required).includes(name), c: asText(p.description), t: p.type ?? 'any', schema: p, client_only: secretKey(name) };
  });
}
function profileFor(action: DirectoryAction): Profile | null {
  const profile = profiles[action.n];
  if (!profile) return null;
  const origin = action.sys === 'relay' ? RELAY : new URL(action.u).origin;
  try {
    const url = new URL(action.u);
    return url.origin === origin && url.pathname === profile.path && !url.search && !url.hash && !url.username && !url.password && action.m === profile.method ? profile : null;
  } catch { return null; }
}
export function attachCapabilityDirectoryRoutes(app: Express, config: CapabilityDirectoryConfig): void {
  const base = config.baseUrl.replace(/\/+$/, ''), baseUrl = new URL(base);
  if (!['https:', 'http:'].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash || baseUrl.pathname !== '/') throw new Error('Capability directory requires a deployment origin');
  let cached: { at: number; value: CapabilityDirectory } | undefined;
  let pending: Promise<CapabilityDirectory> | undefined;
  let active = 0, credits = 30, creditAt = Date.now();
  const getJson = async (url: string): Promise<Row> => {
    const parsed = new URL(url);
    if (parsed.origin !== RELAY || parsed.username || parsed.password || parsed.hash || parsed.search) throw new Error('Untrusted catalog/schema URL');
    const response = await config.fetch(url, { method: 'GET', headers: { Accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('Current contract HTTP ' + response.status);
    const value: unknown = JSON.parse(await readText(response));
    if (!object(value) || !safeJson(value)) throw new Error('Invalid current contract');
    return value;
  };
  const buildDirectory = async (): Promise<CapabilityDirectory> => {
    const now = new Date().toISOString();
    const local: DirectoryAction[] = config.foxxiAffordances.map(a => {
      const annotation = config.annotations?.[a.toolName];
      const schema = publicSchema(affordanceToMcpToolSchema(a).inputSchema) as Row;
      const url = new URL(a.targetTemplate.replace('{base}', base));
      if (url.origin !== baseUrl.origin || url.username || url.password) throw new Error('Local affordance escaped the deployment origin');
      return normalize({
        iri: actionUrl(a.action), sys: a.toolName.startsWith('llm_telemetry.') ? 'telemetry' : 'foxxi', n: a.toolName, t: a.title, d: a.description, m: a.method, u: url.href,
        mt: a.mediaType || 'application/json', in: fields(schema), input_schema: schema,
        ro: a.annotations?.readOnlyHint ?? null, de: a.annotations?.destructiveHint ?? null,
        ix: a.annotations?.idempotentHint ?? null, xr: !!a.externallyRouted,
        auth: annotation?.authorization || 'Consult the operation contract; anonymous access is not implied',
        classification: annotation?.mode || 'declared', requirements: [...(annotation?.requires ?? [])],
        notes: [...(annotation?.notes ?? [])],
      }, annotation);
    });
    const sources: CapabilityDirectory['sources'] = [{ system: 'foxxi', url: base + '/affordances', status: 'current-deployment-contract', checked_at: now, count: local.length }];
    let relay: DirectoryAction[] = [], complete = true;
    try {
      const doc = await getJson(CATALOG), ops = list(doc['hydra:member']);
      if (!ops.length || ops.length > 500 || !ops.every(object) || (doc['hydra:totalItems'] !== undefined && doc['hydra:totalItems'] !== ops.length)) throw new Error('Incomplete operations catalog');
      const seen = new Set<string>(); let missing = 0;
      relay = await mapBounded(ops as Row[], async op => {
        const iri = asText(op.action), name = iri.split('/').pop() || '';
        if (!/^[a-z][a-z0-9_]{0,99}$/.test(name) || iri !== RELAY + '/ns/iep/action/relay/' + name || seen.has(iri)) throw new Error('Invalid or duplicate operation identity');
        seen.add(iri);
        const url = RELAY + '/tool/' + name, schemaUrl = CATALOG + '/' + name + '/input';
        if (op.target !== url || op.expects !== schemaUrl || !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(asText(op.method))) throw new Error('Operation target/schema does not match its trusted identity');
        let schema: Row | null = null;
        try { schema = publicSchema(await getJson(schemaUrl)) as Row; if (schema.$id !== undefined && schema.$id !== schemaUrl) throw new Error('Schema identity mismatch'); }
        catch { missing++; }
        const headers = list(op['hydra:expectsHeader']).filter(object).filter(h => h['hydra:required'] === true).map(h => asText(h['hydra:headerName'])).filter(Boolean);
        return normalize({
          iri, sys: 'relay', n: 'relay.' + name, t: asText(op.title), d: asText(op.description), m: asText(op.method),
          u: url, mt: 'application/json', in: fields(schema), input_schema: schema,
          ro: null, de: null, ix: null, xr: false, auth: headers.length ? 'Advertised required headers: ' + headers.join(', ') : 'Consult the operation contract',
          classification: asText(op.classification), requirements: headers.map(h => 'The operation advertises a required ' + h + ' header; use your own authenticated connector when needed.'), notes: [],
        });
      });
      if (missing) complete = false;
      sources.push({ system: 'relay', url: CATALOG, status: missing ? 'schema-incomplete' : 'live-contract', checked_at: now, count: relay.length, ...(missing ? { error: missing + ' current input schemas unavailable; those requests cannot be validated.' } : {}) });
    } catch {
      complete = false;
      sources.push({ system: 'relay', url: CATALOG, status: 'unavailable', checked_at: now, count: 0, error: 'Current Relay catalog unavailable; no archived entries were substituted.' });
    }
    const actions = [...local, ...relay].sort((a, b) => a.sys.localeCompare(b.sys) || a.t.localeCompare(b.t));
    if (new Set(actions.map(a => a.iri)).size !== actions.length) throw new Error('Duplicate capability identities');
    return { schema: 1, audience: base, build: config.build || 'unset', generated_at: now, complete, sources, actions };
  };
  function normalize(raw: Omit<DirectoryAction, 'execution' | 'example'>, annotation?: CapabilityAnnotation): DirectoryAction {
    const row: DirectoryAction = {
      ...raw,
      execution: { mode: 'prepare-only', reason: 'Validate declared inputs and prepare a call for your connected client. This does not execute the operation, prove authorization or verify domain data.', implemented: annotation?.implementation !== 'not-implemented', side_effects: ['Validation/preparation does not call the target operation.'] },
      example: { payload: {}, label: 'Illustrative request template; replace placeholders with your authorized inputs', provenance: 'example', warning: 'Example inputs are not learner evidence, source assertions, real credentials or production records.' },
    };
    if (annotation?.signing) row.signing = {
      schema: publicSchema(annotation.signing.schema) as Row,
      payload: redactedExample({ ...annotation.signing.payload, bridge_audience: base }) as Row,
      instructions: [...annotation.signing.instructions],
    };
    const profile = profileFor(row);
    const unavailable = annotation?.implementation === 'not-implemented';
    const clientOnly = row.sys === 'relay' && ['relay.setup_identity', 'relay.link_wallet'].includes(row.n);
    if (unavailable) row.execution = { mode: 'unavailable', reason: 'This advertised operation is not currently implemented. No execution is offered.', implemented: false, side_effects: [] };
    else if (clientOnly) row.execution = { mode: 'client-only', reason: 'Identity setup and wallet linking use the connected client’s existing OAuth identity flow. The remote tool cannot perform an independent browser setup here.', implemented: true, side_effects: ['No identity or wallet is created by this workbench.'] };
    else if (profile) row.execution = {
      mode: profile.task ? 'client-required' : 'public-example',
      reason: profile.task ? 'Generate real public-context instructions here; your connected AI executes them with its own model. No model answer or completed workflow is fabricated.' : 'Run this explicitly reviewed, bounded public example against the current live endpoint.',
      implemented: true, side_effects: ['No primary domain/pod/lattice mutation or project-paid model call.', 'Service access logs and operational telemetry may be recorded.'],
    };
    const declared = annotation?.example;
    const schemaExample = list(row.input_schema?.examples).find(object);
    const generated = exampleValue(row.input_schema, 'arguments');
    row.example.payload = redactedExample(profile?.payload || declared?.arguments || (object(schemaExample) ? schemaExample : object(generated) ? generated : {})) as Row;
    row.example.label = profile?.label || declared?.label || row.example.label;
    return row;
  }
  const directory = async (): Promise<CapabilityDirectory> => {
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
    if (!pending) pending = buildDirectory().then(value => { cached = { at: Date.now(), value }; return value; }).finally(() => { pending = undefined; });
    return pending;
  };
  const reply = (res: ExpressResponse, value: unknown, status = 200) => res.status(status).set('Cache-Control', 'no-store').json(value);
  app.get('/i2idlx/directory', async (_req, res) => {
    try { reply(res, await directory()); }
    catch { reply(res, { error: 'Current capability directory unavailable; no successful verification was fabricated.' }, 503); }
  });
  app.post('/i2idlx/directory/run', async (req, res) => {
    const checked_at = new Date().toISOString();
    let boundAction: string | undefined;
    const respond = (value: Row, status = 200) => reply(res, { ...(boundAction ? { action_iri: boundAction } : {}), ...value }, status);
    if (object(req.body) && typeof req.body.action_iri === 'string' && /^https:\/\/relay\.interego\.xwisee\.com\/ns\/iep\/action\/[a-z0-9_/-]{1,300}$/.test(req.body.action_iri)) boundAction = req.body.action_iri;
    try {
      const body: unknown = req.body;
      if (!object(body) || !allowedKeys(body, ['action_iri', 'payload', 'mode']) || !short(body.action_iri, 512) || !['example', 'validate'].includes(String(body.mode)) || !object(body.payload) || !safeJson(body.payload) || Buffer.byteLength(JSON.stringify(body), 'utf8') > MAX_INPUT) {
        respond({ status: 'invalid', executed: false, error: 'Provide only action_iri, mode (example or validate), and a safe JSON payload within 64 KB.' }, 400); return;
      }
      // Credentials stay in the connected client. Refuse before echoing request data or contacting a target.
      if (carriesSecrets(body, body.mode === 'validate')) { respond({ status: 'refused', executed: false, error: 'Do not send credentials or signatures to the public example runner. Keep them in your connected client and use placeholders for contract checks.' }, 400); return; }
      const data = await directory(), action = data.actions.find(a => a.iri === body.action_iri);
      if (!action) { respond({ status: 'refused', executed: false, error: 'Action is absent from the current trusted directory.' }, 404); return; }
      boundAction = action.iri;
      const validation = validateDirectoryPayload(action.input_schema, body.payload);
      const request = { action_iri: action.iri, method: action.m, url: action.u, payload: body.payload };
      const common = { action_iri: action.iri, mode: body.mode, checked_at, request, validation, requirements: action.requirements,
        primary_writes_performed: false, telemetry: { may_record: true, note: 'Service access logs and operational telemetry may be recorded. Contract validation does not call the target.' } };
      if (!validation.valid) { respond({ ...common, status: 'invalid', executed: false, evidence: { source: 'schema-only' } }, 400); return; }
      if (body.mode === 'validate') {
        respond({ ...common, status: 'contract-valid', executed: false, evidence: { source: 'schema-only' }, next_step: 'Use this exact action and your own authorized inputs/credentials in a connected client. Input validation does not prove that the target executed or that its domain prerequisites are met.' }); return;
      }
      const profile = profileFor(action);
      if (!profile || !['public-example', 'client-required'].includes(action.execution.mode) || !profile.check(body.payload)) {
        respond({ ...common, status: 'refused', executed: false, evidence: { source: 'schema-only' }, error: 'This request is outside the bounded public example profile. Validate and prepare it for your connected client instead.' }, 403); return;
      }
      credits = Math.min(30, credits + (Date.now() - creditAt) / 1000); creditAt = Date.now();
      if (active >= 6 || credits < 1) { respond({ ...common, status: 'refused', executed: false, error: 'Example runner is busy; retry shortly.' }, 429); return; }
      credits--; active++;
      try {
        const url = new URL(action.u);
        if (url.origin !== (action.sys === 'relay' ? RELAY : baseUrl.origin)) throw new Error('Target origin changed');
        if (action.m === 'GET') for (const [key, value] of Object.entries(body.payload)) url.searchParams.set(key, String(value));
        const started = Date.now();
        const response = await config.fetch(url.href, { method: profile.method, headers: { Accept: 'application/json', ...(profile.method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
          ...(profile.method === 'POST' ? { body: JSON.stringify(body.payload) } : {}), redirect: 'manual', signal: AbortSignal.timeout(10000) });
        const text = await readText(response);
        let result: unknown = text;
        if (text && /json/i.test(response.headers.get('content-type') || '')) { try { result = JSON.parse(text); } catch { throw new Error('Live response was invalid JSON'); } }
        const refusal = !response.ok || (object(result) && (result.kind === 'refusal' || result.ok === false || result.skipped === true || (result.error !== undefined && result.error !== null) || (typeof result.code === 'number' && result.code >= 400)));
        respond({ ...common, status: refusal ? 'refused' : 'executed', executed: !refusal, result,
          evidence: { source: 'live-http', http_status: response.status, duration_ms: Date.now() - started, target: url.href, invocation_attempted: true, scope: profile.task ? 'task-packet-generation-only' : 'target-operation-response' },
          ...(profile.task ? { next_step: 'Execute the returned instructions in your connected AI client. No model sampling, answer, workflow completion or domain write occurred here.' } : {}) }, refusal ? 502 : 200);
      } finally { active--; }
    } catch { respond({ status: 'unavailable', executed: false, checked_at, error: 'Live capability request could not be confirmed; no successful result was fabricated.' }, 503); }
  });
}
