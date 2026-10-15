#!/usr/bin/env node
/** Post-cutover preservation only: reads existing ciphertext/history, never readies the database or commits. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ImportRefusal, decryptSnapshot, decryptCheckpoint, buildNativePlan, verifyPlan, parseArguments } from './import.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const fail = code => { throw new ImportRefusal(code); };
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const same = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));

function validateCheckpoint(plan, checkpoint, scope) {
  const binding = sha(JSON.stringify({ ...plan.bindings, scope }));
  if (!checkpoint || checkpoint.schema !== 'interego-native-lrs-import-checkpoint-v1'
    || checkpoint.stage !== 'complete' || checkpoint.cutoverReady !== true || !checkpoint.finalHead
    || checkpoint.binding !== binding || !same(checkpoint.scope, scope)
    || !same(checkpoint.bindings, plan.bindings)
    || checkpoint.primaryOperation !== 'foxxi-lrs-restore:' + binding + ':primary'
    || checkpoint.queryOperation !== 'foxxi-lrs-restore:' + binding + ':queries') fail('preservation-checkpoint-binding-mismatch');
}

/** Adds no records and tolerates additional current keys, while every original primary and alias must still match. */
export async function verifyPreservation(database, plan, runtime, checkpoint) {
  await database.client.ready(); // OPTIONS only. database.ready() would publish a new no-op head.
  const current = await database.client.readHead();
  validateCheckpoint(plan, checkpoint, current.scope);
  const restored = await database.client.readSnapshotAt(checkpoint.finalHead);
  if (!same(restored.scope, current.scope) || !same(restored.reference, checkpoint.finalHead)) fail('preservation-checkpoint-head-mismatch');
  const historical = await verifyPlan(database, plan, restored, runtime, true);
  const expectedKeys = new Set([...plan.primary, ...plan.queries].map(change => change.key));
  const subset = new Map();
  for (const key of expectedKeys) {
    const reference = current.records.get(key);
    if (!reference) fail('preservation-original-record-missing-from-current-head');
    subset.set(key, reference);
  }
  // A new void edge is an extra key but changes an original statement's current envelope.
  // Check the full current head before narrowing; otherwise the subset would conceal that change.
  for (const row of plan.source.records) if (!row.original.voided
    && await database.read(current, row.tenant, 'void', row.id)) fail('preservation-original-void-state-changed');
  // verifyPlan compares exact artifacts, provenance, statement JSON, metadata/bytes and void reconstruction.
  // Narrowing only this record map means extras are explicitly outside the original-set comparison.
  await verifyPlan(database, plan, { ...current, records: subset }, runtime, true);
  const extraNativeRecordsByKind = {};
  let extraNativeRecords = 0;
  for (const key of current.records.keys()) if (!expectedKeys.has(key)) {
    extraNativeRecords++;
    const kind = /^foxxi-lrs\/v1\/[^/]+\/([A-Za-z]+)\//.exec(key)?.[1] ?? 'other';
    extraNativeRecordsByKind[kind] = (extraNativeRecordsByKind[kind] ?? 0) + 1;
  }
  const latest = await database.client.readHead();
  const latestHeadUnchangedDuringVerification = same(latest.reference, current.reference);
  return {
    ok: true, readOnly: true, sourceArchiveAuthenticated: true, sourceCheckpointAuthenticated: true,
    checkpointBindingVerified: true, sourceAsOfOnly: true,
    ...plan.source.counts, ...plan.source.sourceProjection,
    sourceDigest: plan.source.sourceDigest, archiveDigest: plan.source.archiveDigest,
    targetSourceSha256: plan.source.targetSourceSha256, restoredRecordSetSha256: plan.bindings.planDigest,
    expectedOriginalPrimaryRecords: plan.primary.length, expectedOriginalQueryAliases: plan.queries.length,
    checkpointHeadOriginalsExact: true, fixedCurrentHeadOriginalsExact: true,
    exactStatementWireBodies: historical.exactStatementWireBodies,
    exactStoredAuthorityAndVoidFlags: historical.exactStoredAuthorityAndVoidFlags,
    exactOpaqueCollectionKeys: historical.exactOpaqueCollectionKeys,
    exactDocumentMetadataAndBytes: historical.exactDocumentMetadataAndBytes,
    checkpointHead: restored.reference, verifiedCurrentHead: current.reference,
    latestHeadAtEnd: latest.reference, latestHeadUnchangedDuringVerification,
    extraNativeRecords, extraNativeRecordsByKind,
    extrasClassifiedAsLegitimate: false,
    bounds: 'Every original primary and alias was verified at both reported fixed heads. Extra keys were counted only; their legitimacy and any head published during verification were not verified. This is not final cutover, source-delta reconciliation or a claim of new learner achievement.',
  };
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  if (args.has('--apply') || args.has('--offline')) fail('preservation-is-read-only-online-verification');
  const archivePath = args.get('--archive'), checkpointPath = args.get('--checkpoint'), expectedSource = args.get('--expect-source-sha');
  if (!archivePath || !checkpointPath || !/^[a-f0-9]{64}$/.test(expectedSource ?? '')) fail('preservation-requires-archive-checkpoint-and-source-sha');
  const seed = process.env.FOXXI_ADMIN_KEY_SEED;
  const source = decryptSnapshot(await readFile(resolve(archivePath), 'utf8'), seed,
    { omitLegacyUndefinedProperties: args.get('--omit-legacy-undefined-properties') === true });
  if (source.targetSourceSha256 !== expectedSource) fail('source-script-mismatch');
  const checkpoint = decryptCheckpoint(await readFile(resolve(checkpointPath), 'utf8'), seed);
  const runtimePath = resolve(args.get('--runtime') || resolve(dirname(new URL(import.meta.url).pathname), 'runtime.mjs'));
  const runtime = await import(pathToFileURL(runtimePath).href);
  const database = runtime.createConfiguredNativeLrsDatabase();
  try {
    const plan = buildNativePlan(database, source, runtime);
    console.log(JSON.stringify(await verifyPreservation(database, plan, runtime, checkpoint)));
  } finally { await database.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => {
  console.error(JSON.stringify({ ok: false, readOnly: true,
    code: error instanceof ImportRefusal ? error.code : 'preservation-verification-failed',
    bounds: 'No native mutation or checkpoint update was attempted. Original preservation is not established by this failed run.' }));
  process.exitCode = 1;
});
