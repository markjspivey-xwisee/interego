import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAppleBatch, AppleBatchValidationError, APPLE_MAX_SAMPLES } from '../apple.mjs';

const now = '2026-10-31T16:00:00Z';
const when = '2026-10-30T12:00:00-04:00';
const uuid = '13D48DD2-3983-462B-AC2A-6BFA351E2400';
const sample = (overrides = {}) => ({ metric: 'bodyMass', value: 150, unit: 'lb', startDate: when, endDate: when, source: { name: 'Health', device: 'Mayya iPhone' }, ...overrides });
const batch = (samples = [sample()], overrides = {}) => ({ version: 1, deviceId: 'paired-phone-1', samples, ...overrides });
const normalize = input => normalizeAppleBatch(input, { now });
const invalid = (input, pattern) => assert.throws(() => normalize(input), e => e instanceof AppleBatchValidationError && e.status === 400 && pattern.test(e.message));

test('normalizes units and dates without changing raw values or the input', () => {
  const input = batch();
  const before = JSON.stringify(input);
  const result = normalize(input);
  const s = result.samples[0];
  assert.equal(s.metric, 'bodyMass');
  assert.equal(s.unit, 'kg');
  assert.equal(s.value, 150 * 0.45359237);
  assert.equal(s.startDate, '2026-10-30T16:00:00.000Z');
  assert.equal(s.raw.value, 150);
  assert.equal(s.raw.unit, 'lb');
  assert.equal(s.raw.startDate, when);
  assert.equal(s.source.name, 'Health');
  assert.equal(JSON.stringify(input), before);
  assert.ok(Object.isFrozen(result.samples[0].raw));
  assert.throws(() => { s.raw.value = 151; }, TypeError);
});

test('derived ids and batch ids are deterministic across property and sample order', () => {
  const a = sample();
  const b = sample({ metric: 'heartRate', value: 70, unit: 'bpm' });
  const first = normalize(batch([a, b]));
  const second = normalize(batch([b, { ...a, source: { device: 'Mayya iPhone', name: 'Health' } }]));
  assert.deepEqual(first.samples.map(s => s.id), second.samples.map(s => s.id));
  assert.equal(first.batchId, second.batchId);
  assert.equal(first.samples[0].idKind, 'derived-content-sha256');
  assert.equal(first.coverage.complete, false);
  assert.ok(first.warnings.some(w => w.code === 'derived_ids_are_not_native_uuids'));
});

test('deduplicates exact retries but rejects conflicting native UUID contents', () => {
  const a = sample({ id: uuid });
  const result = normalize(batch([a, { ...a }]));
  assert.equal(result.samples.length, 1);
  assert.equal(result.samples[0].id, `healthkit:${uuid.toLowerCase()}`);
  assert.equal(result.samples[0].idKind, 'client-asserted-healthkit-uuid');
  assert.equal(result.warnings.find(w => w.code === 'duplicate_samples_deduplicated').count, 1);
  invalid(batch([a, { ...a, value: 155 }]), /conflicting contents/);
  invalid(batch([sample({ id: 'fake-sample-id' })]), /HealthKit sample UUID/);
});

test('retains overlapping phone/watch sources without computing a total', () => {
  const a = sample({ metric: 'steps', value: 100, unit: 'count', source: 'iPhone' });
  const b = { ...a, source: 'Apple Watch' };
  const result = normalize(batch([a, b]));
  assert.equal(result.samples.length, 2);
  assert.equal(result.samples.reduce((a, s) => a + s.value, 0), 200); // Only the test performs this intentionally naive sum.
  assert.ok(!Object.hasOwn(result, 'totals'));
  assert.ok(result.warnings.some(w => w.code === 'sources_not_aggregated'));
});

test('validates allowlisted quantities and explicit units', () => {
  invalid(batch([sample({ metric: 'bloodPressure' })]), /allowlist/);
  invalid(batch([sample({ value: '150' })]), /finite nonnegative number/);
  invalid(batch([sample({ value: Infinity })]), /finite nonnegative number/);
  invalid(batch([sample({ value: -1 })]), /nonnegative/);
  invalid(batch([sample({ unit: 'stone' })]), /kg, g or lb/);
  invalid(batch([sample({ metric: 'steps', value: 1.1, unit: 'count' })]), /integer count/);
  invalid(batch([sample({ metric: 'heartRate', value: 70, unit: 'kg' })]), /count\/min or bpm/);
});

test('normalizes oxygen fractions and energy without guessing missing units', () => {
  const result = normalize(batch([
    sample({ metric: 'oxygenSaturation', value: 0.96, unit: '1' }),
    sample({ metric: 'oxygenSaturation', value: 96, unit: '%' }),
    sample({ metric: 'activeEnergy', value: 418.4, unit: 'kJ' }),
  ]));
  assert.deepEqual(result.samples.filter(s => s.metric === 'oxygenSaturation').map(s => [s.value, s.unit]), [[96, '%'], [96, '%']]);
  assert.ok(Math.abs(result.samples.find(s => s.metric === 'activeEnergy').value - 100) < 1e-9);
  invalid(batch([sample({ metric: 'oxygenSaturation', value: 96, unit: '1' })]), /unit range/);
  invalid(batch([sample({ metric: 'oxygenSaturation', value: 101, unit: '%' })]), /unit range/);
  invalid(batch([sample({ unit: undefined })]), /explicitly supplied unit/);
});

test('sleep preserves categories without claiming total sleep duration', () => {
  const result = normalize(batch([sample({ metric: 'sleep', value: 'rem', unit: 'category' })]));
  assert.equal(result.samples[0].value, 'rem');
  assert.equal(result.samples[0].unit, 'category');
  assert.ok(!Object.hasOwn(result.samples[0], 'sleepDuration'));
  invalid(batch([sample({ metric: 'sleep', value: 7, unit: 'h' })]), /sleep requires/);
});

test('requires explicit timezone and valid calendar and event order', () => {
  invalid(batch([sample({ startDate: '2026-10-30T12:00:00' })]), /explicit timezone/);
  invalid(batch([sample({ startDate: '2026-02-30T12:00:00Z' })]), /calendar timestamp/);
  invalid(batch([sample({ startDate: '2026-10-30T12:00:00+14:30' })]), /calendar timestamp/);
  invalid(batch([sample({ endDate: '2026-10-29T12:00:00Z' })]), /precede startDate/);
  invalid(batch([sample({ startDate: '2026-11-01T12:00:00Z', endDate: '2026-11-01T12:00:00Z' })]), /ahead of/);
});

test('validates the optional window without claiming it is complete', () => {
  const result = normalize(batch([sample()], { windowStart: '2026-10-30T00:00:00Z', windowEnd: '2026-10-31T00:00:00Z' }));
  assert.equal(result.windowStart, '2026-10-30T00:00:00.000Z');
  assert.equal(result.coverage.historyComplete, false);
  invalid(batch([sample()], { windowStart: '2026-10-30T00:00:00Z' }), /provided together/);
  invalid(batch([sample()], { windowStart: '2026-10-29T00:00:00Z', windowEnd: '2026-10-29T23:00:00Z' }), /intersect/);
});

test('native tombstones are explicit and cannot be inferred from Shortcuts or silence', () => {
  const deletion = { id: uuid, metric: 'bodyMass', deletedAt: '2026-10-31T12:00:00Z' };
  invalid(batch([], { deletions: [deletion] }), /native HealthKit client/);
  const native = normalize(batch([], { client: 'healthkit-native', deletions: [deletion] }));
  assert.equal(native.deletions.length, 1);
  assert.equal(native.deletions[0].id, `healthkit:${uuid.toLowerCase()}`);
  invalid(batch([sample({ id: uuid })], { client: 'healthkit-native', deletions: [deletion] }), /both add and delete/);
  invalid(batch([], { client: 'healthkit-native', deletions: [{ id: 'derived:abc' }] }), /native HealthKit UUID/);
  const empty = normalize(batch([]));
  assert.equal(empty.deletions.length, 0);
  assert.equal(empty.coverage.complete, false);
  assert.ok(empty.warnings.some(w => w.code === 'empty_upload_is_not_absence_or_deletion'));
});

test('bounds samples, envelope metadata and declared coverage', () => {
  invalid(batch(Array.from({ length: APPLE_MAX_SAMPLES + 1 }, () => sample())), /at most 1000/);
  invalid(batch([sample()], { patientId: 'someone-else' }), /unknown property patientId/);
  invalid(batch([sample()], { coverage: { complete: true } }), /cannot attest complete history/);
  invalid(batch([sample()], { coverage: { metrics: ['steps'] } }), /outside the declared/);
  invalid(batch([sample({ source: JSON.parse('{"__proto__":{"admin":true}}') })]), /unsafe source/);
  invalid(batch([sample({ source: 'x'.repeat(513) })]), /bounded JSON/);
});

test('supports the documented version alias and valid empty selected-metric upload', () => {
  const result = normalize({ schemaVersion: 'interego.apple-health.samples.v1', deviceId: 'phone-1', samples: [], coverage: { mode: 'selected-samples', metrics: ['sleep'], complete: false } });
  assert.deepEqual(result.coverage.metrics, ['sleep']);
  assert.equal(result.coverage.permissionState, 'not-inferable-from-upload');
  invalid({ deviceId: 'phone', samples: [] }, /requires version 1/);
  invalid(batch([], { version: 2 }), /requires version 1/);
});
