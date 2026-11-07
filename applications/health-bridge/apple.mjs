import { createHash } from 'node:crypto';

/**
 * Normalizes a deliberately small, read-only Apple Health upload vocabulary.
 * This validates a client's claims; it does not authenticate HealthKit provenance,
 * establish permission completeness, aggregate overlapping samples, or publish data.
 */
export const APPLE_BATCH_VERSION = 1;
export const APPLE_BATCH_SCHEMA = 'interego.apple-health.samples.v1';
export const APPLE_MAX_SAMPLES = 1000;
export const APPLE_MAX_BATCH_BYTES = 1024 * 1024;

const TYPES = Object.freeze({
  steps: 'HKQuantityTypeIdentifierStepCount',
  heartRate: 'HKQuantityTypeIdentifierHeartRate',
  restingHeartRate: 'HKQuantityTypeIdentifierRestingHeartRate',
  activeEnergy: 'HKQuantityTypeIdentifierActiveEnergyBurned',
  bodyMass: 'HKQuantityTypeIdentifierBodyMass',
  oxygenSaturation: 'HKQuantityTypeIdentifierOxygenSaturation',
  sleep: 'HKCategoryTypeIdentifierSleepAnalysis',
});
export const APPLE_METRICS = Object.freeze(Object.keys(TYPES));
const METRICS = new Set(APPLE_METRICS);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SLEEP = new Set(['inBed', 'awake', 'asleep', 'asleepUnspecified', 'core', 'deep', 'rem']);
const ENVELOPE_KEYS = new Set(['version', 'schemaVersion', 'deviceId', 'batchId', 'client', 'sentAt', 'windowStart', 'windowEnd', 'samples', 'deletions', 'coverage']);
const SAMPLE_KEYS = new Set(['metric', 'id', 'value', 'unit', 'startDate', 'endDate', 'source']);
const DELETION_KEYS = new Set(['id', 'metric', 'deletedAt']);
const COVERAGE_KEYS = new Set(['mode', 'metrics', 'complete']);

export class AppleBatchValidationError extends Error {
  constructor(message, path = 'batch', code = 'invalid_apple_batch') {
    super(`${path}: ${message}`);
    this.name = 'AppleBatchValidationError';
    this.code = code;
    this.status = 400;
    this.statusCode = 400;
    this.path = path;
  }
}

function fail(message, path, code) { throw new AppleBatchValidationError(message, path, code); }
function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function object(value, path, keys) {
  if (!plain(value)) fail('must be a JSON object', path);
  if (keys) for (const key of Object.keys(value)) {
    if (!keys.has(key)) fail(`unknown property ${key}`, path);
  }
  return value;
}
function identifier(value, path) {
  if (typeof value !== 'string' || !ID.test(value)) fail('must be 1–128 letters, digits, dots, colons, underscores or hyphens', path);
  return value;
}
function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (plain(value)) return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
function frozen(value) {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) frozen(item);
    Object.freeze(value);
  }
  return value;
}
function sourceJSON(value, path, depth = 0) {
  if (depth > 4) fail('source metadata is too deeply nested', path);
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.length <= 512) return value;
  if (Array.isArray(value) && value.length <= 20) return value.map((x, i) => sourceJSON(x, `${path}[${i}]`, depth + 1));
  if (plain(value) && Object.keys(value).length <= 20) {
    const result = Object.create(null);
    for (const [key, item] of Object.entries(value)) {
      if (key.length > 128 || ['__proto__', 'prototype', 'constructor'].includes(key)) fail('unsafe source metadata key', path);
      result[key] = sourceJSON(item, `${path}.${key}`, depth + 1);
    }
    return result;
  }
  fail('must contain bounded JSON source metadata', path);
}

/** Requires an explicit timezone; does not silently repair impossible dates. */
function timestamp(value, path, nowMs) {
  if (typeof value !== 'string') fail('must be an ISO 8601 timestamp with a timezone', path);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) fail('must be an ISO 8601 timestamp with seconds and an explicit timezone', path);
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const offsetHour = Number(match[10] ?? 0);
  const offsetMinute = Number(match[11] ?? 0);
  const date = new Date(0);
  date.setUTCFullYear(year, month, 0);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > date.getUTCDate()
    || hour > 23 || minute > 59 || second > 59 || offsetHour > 14 || offsetMinute > 59
    || (offsetHour === 14 && offsetMinute !== 0)) fail('is not a valid calendar timestamp', path);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) fail('is not a supported timestamp', path);
  if (ms > nowMs + 5 * 60 * 1000) fail('is more than five minutes ahead of the receiving clock', path);
  return { iso: new Date(ms).toISOString(), ms };
}

function quantity(metric, value, unit, path) {
  if (typeof unit !== 'string') fail('must be an explicitly supplied unit', `${path}.unit`);
  if (metric === 'sleep') {
    if (unit !== 'category' || typeof value !== 'string' || !SLEEP.has(value)) {
      fail('sleep requires unit category and one of inBed, awake, asleep, asleepUnspecified, core, deep, rem', path);
    }
    return { value, unit: 'category' };
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) fail('must be a finite nonnegative number', `${path}.value`);
  let normalized;
  if (metric === 'steps') {
    if (!['count', 'steps'].includes(unit) || !Number.isSafeInteger(value)) fail('steps require an integer count and unit count or steps', path);
    normalized = { value, unit: 'count' };
  } else if (metric === 'heartRate' || metric === 'restingHeartRate') {
    if (!['count/min', 'bpm'].includes(unit)) fail('heart rate unit must be count/min or bpm', `${path}.unit`);
    normalized = { value, unit: 'count/min' };
  } else if (metric === 'activeEnergy') {
    if (!['kcal', 'kJ', 'J'].includes(unit)) fail('active energy unit must be kcal, kJ or J', `${path}.unit`);
    normalized = { value: unit === 'kJ' ? value / 4.184 : unit === 'J' ? value / 4184 : value, unit: 'kcal' };
  } else if (metric === 'bodyMass') {
    if (!['kg', 'g', 'lb'].includes(unit) || value === 0) fail('body mass requires a positive quantity with unit kg, g or lb', path);
    normalized = { value: unit === 'lb' ? value * 0.45359237 : unit === 'g' ? value / 1000 : value, unit: 'kg' };
  } else if (metric === 'oxygenSaturation') {
    if (!['%', '1', 'fraction'].includes(unit)) fail('oxygen saturation unit must be %, 1 or fraction', `${path}.unit`);
    if (value > (unit === '%' ? 100 : 1)) fail('oxygen saturation must be within the stated unit range', `${path}.value`);
    normalized = { value: unit === '%' ? value : value * 100, unit: '%' };
  }
  if (!normalized || !Number.isFinite(normalized.value)) fail('quantity conversion is not finite', path);
  return normalized;
}

/**
 * Input envelope: {version:1,deviceId,client?,batchId?,windowStart?,windowEnd?,
 * samples:[{metric,id?,value,unit,startDate,endDate,source?}],deletions?,coverage?}.
 * A supplied id must be a client-asserted HealthKit UUID. The native origin itself
 * is not independently verified. Generated content hashes are explicitly labeled.
 */
export function normalizeAppleBatch(input, { now = Date.now() } = {}) {
  object(input, 'batch', ENVELOPE_KEYS);
  let encoded;
  try { encoded = JSON.stringify(input); } catch { fail('must be serializable JSON', 'batch'); }
  if (Buffer.byteLength(encoded, 'utf8') > APPLE_MAX_BATCH_BYTES) fail('exceeds the one MiB normalization limit', 'batch', 'apple_batch_too_large');
  const hasVersion = input.version !== undefined;
  const hasSchema = input.schemaVersion !== undefined;
  if ((!hasVersion && !hasSchema) || (hasVersion && input.version !== APPLE_BATCH_VERSION)
    || (hasSchema && ![1, APPLE_BATCH_SCHEMA].includes(input.schemaVersion))) fail('requires version 1', 'batch.version');
  const deviceId = identifier(input.deviceId, 'batch.deviceId');
  const client = input.client ?? 'shortcuts';
  if (!['shortcuts', 'healthkit-native'].includes(client)) fail('must be shortcuts or healthkit-native', 'batch.client');
  const nowMs = now instanceof Date ? now.getTime() : typeof now === 'number' ? now : Date.parse(now);
  if (!Number.isFinite(nowMs)) fail('receiving clock is invalid', 'options.now');
  if (input.sentAt !== undefined) timestamp(input.sentAt, 'batch.sentAt', nowMs);
  const start = input.windowStart === undefined ? undefined : timestamp(input.windowStart, 'batch.windowStart', nowMs);
  const end = input.windowEnd === undefined ? undefined : timestamp(input.windowEnd, 'batch.windowEnd', nowMs);
  if (Boolean(start) !== Boolean(end)) fail('windowStart and windowEnd must be provided together', 'batch');
  if (start && end.ms < start.ms) fail('must not precede windowStart', 'batch.windowEnd');
  if (!Array.isArray(input.samples) || input.samples.length > APPLE_MAX_SAMPLES) fail('must be an array of at most 1000 samples', 'batch.samples');
  const deletionInput = input.deletions ?? [];
  if (!Array.isArray(deletionInput) || deletionInput.length > APPLE_MAX_SAMPLES) fail('must be an array of at most 1000 tombstones', 'batch.deletions');
  if (deletionInput.length && client !== 'healthkit-native') fail('deletion tombstones require the native HealthKit client; empty Shortcuts results never imply deletion', 'batch.deletions');
  const warnings = [];
  const seen = new Map();
  let duplicateCount = 0;
  for (const [index, item] of input.samples.entries()) {
    const path = `batch.samples[${index}]`;
    object(item, path, SAMPLE_KEYS);
    if (!METRICS.has(item.metric)) fail('metric is not on the selected-sample allowlist', `${path}.metric`);
    const startDate = timestamp(item.startDate, `${path}.startDate`, nowMs);
    const endDate = timestamp(item.endDate, `${path}.endDate`, nowMs);
    if (endDate.ms < startDate.ms) fail('must not precede startDate', `${path}.endDate`);
    // Include intervals intersecting the selected window; do not silently drop them.
    if (start && (endDate.ms < start.ms || startDate.ms > end.ms)) fail('sample does not intersect the declared window', path);
    const normalized = quantity(item.metric, item.value, item.unit, path);
    const source = item.source === undefined ? null : sourceJSON(item.source, `${path}.source`);
    if (Buffer.byteLength(JSON.stringify(source), 'utf8') > 4096) fail('source metadata exceeds 4096 bytes', `${path}.source`);
    if (item.id !== undefined && (typeof item.id !== 'string' || !UUID.test(item.id))) fail('id must be a HealthKit sample UUID; omit it when the client cannot retrieve one', `${path}.id`);
    const raw = { value: item.value, unit: item.unit, startDate: item.startDate, endDate: item.endDate };
    const identity = { deviceId, metric: item.metric, raw, source };
    const nativeId = item.id?.toLowerCase();
    const id = nativeId ? `healthkit:${nativeId}` : `derived:${hash(stable(identity))}`;
    const sample = { id, idKind: nativeId ? 'client-asserted-healthkit-uuid' : 'derived-content-sha256', metric: item.metric, healthKitType: TYPES[item.metric], ...normalized, startDate: startDate.iso, endDate: endDate.iso, source, raw };
    const previous = seen.get(id);
    if (previous) {
      if (stable(previous) !== stable(sample)) fail('same sample id has conflicting contents', `${path}.id`);
      duplicateCount += 1;
    } else seen.set(id, sample);
  }
  const samples = [...seen.values()].sort((a, b) => a.id.localeCompare(b.id));
  const deletions = [];
  const deletedIds = new Set();
  for (const [index, item] of deletionInput.entries()) {
    const path = `batch.deletions[${index}]`;
    object(item, path, DELETION_KEYS);
    if (typeof item.id !== 'string' || !UUID.test(item.id)) fail('deletion id must be a native HealthKit UUID, not a derived id', `${path}.id`);
    if (item.metric !== undefined && !METRICS.has(item.metric)) fail('metric is not on the selected-sample allowlist', `${path}.metric`);
    const id = `healthkit:${item.id.toLowerCase()}`;
    if (seen.has(id)) fail('a batch cannot both add and delete the same sample', path);
    const deletedAt = item.deletedAt === undefined ? undefined : timestamp(item.deletedAt, `${path}.deletedAt`, nowMs).iso;
    if (!deletedIds.has(id)) deletions.push({ id, idKind: 'client-asserted-healthkit-uuid', ...(item.metric ? { metric: item.metric } : {}), ...(deletedAt ? { deletedAt } : {}) });
    deletedIds.add(id);
  }
  deletions.sort((a, b) => a.id.localeCompare(b.id));
  const actualMetrics = [...new Set([...samples.map(s => s.metric), ...deletions.map(d => d.metric).filter(Boolean)])].sort();
  let selectedMetrics = actualMetrics;
  if (input.coverage !== undefined) {
    object(input.coverage, 'batch.coverage', COVERAGE_KEYS);
    if (input.coverage.mode !== undefined && input.coverage.mode !== 'selected-samples') fail('only selected-samples coverage is supported', 'batch.coverage.mode');
    if (input.coverage.complete !== undefined && input.coverage.complete !== false) fail('this protocol cannot attest complete history or authorize window replacement', 'batch.coverage.complete');
    if (input.coverage.metrics !== undefined) {
      if (!Array.isArray(input.coverage.metrics) || input.coverage.metrics.length > APPLE_METRICS.length
        || input.coverage.metrics.some(m => !METRICS.has(m))) fail('must be an array of allowlisted metrics', 'batch.coverage.metrics');
      selectedMetrics = [...new Set(input.coverage.metrics)].sort();
      if (actualMetrics.some(m => !selectedMetrics.includes(m))) fail('contains a sample outside the declared selected metrics', 'batch.coverage.metrics');
    }
  }
  const coverage = { mode: 'selected-samples', client, metrics: selectedMetrics, complete: false, historyComplete: false, permissionState: 'not-inferable-from-upload', deletionSupport: client === 'healthkit-native' ? 'client-supplied-native-tombstones' : 'none' };
  if (duplicateCount) warnings.push({ code: 'duplicate_samples_deduplicated', count: duplicateCount });
  if (samples.some(s => s.idKind === 'derived-content-sha256')) warnings.push({ code: 'derived_ids_are_not_native_uuids', detail: 'Content hashes support retry deduplication; they do not establish HealthKit object identity or deletion support.' });
  if (!samples.length && !deletions.length) warnings.push({ code: 'empty_upload_is_not_absence_or_deletion', detail: 'No records were supplied. Permissions, a locked device, the selected window and actual absence cannot be distinguished by this upload.' });
  warnings.push({ code: 'sources_not_aggregated', detail: 'Samples and source metadata are preserved. No overlapping-source totals or medical interpretations were computed.' });
  const identity = { deviceId, ...(start ? { windowStart: start.iso, windowEnd: end.iso } : {}), samples, deletions, coverage };
  const batchId = input.batchId === undefined ? `derived-batch:${hash(stable(identity))}` : identifier(input.batchId, 'batch.batchId');
  return frozen({ deviceId, batchId, ...(start ? { windowStart: start.iso, windowEnd: end.iso } : {}), samples, deletions, coverage, warnings });
}
