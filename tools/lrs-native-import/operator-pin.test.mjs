import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareMaintenanceChild, parseWrapperArguments, writePublicOperatorPin } from './run-in-container.mjs';
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveAdminKeyPair, deriveEncryptionKeyPair, createEncryptedEnvelope, openEncryptedEnvelope } from './runtime.mjs';

const environment = () => ({
  FOXXI_TENANT_POD_URL: 'https://native.test/existing-tenant/',
  FOXXI_AUTHORITATIVE_SOURCE: 'did:web:existing-tenant.test',
  FOXXI_ADMIN_KEY_SEED: 'synthetic-existing-admin-seed:private-fixture-only',
  FOXXI_POD_WRITE_SECRET: 'synthetic-existing-gate-capability:private-fixture-only',
  FOXXI_BRIDGE_PRIVATE_KEY: '0x' + '13'.repeat(32),
});

test('explicit operator pin uses preexisting keys/capability without publication reads and proves both native recipients', async () => {
  const env = environment(), before = structuredClone(env); let networkCalls = 0;
  const fetchImpl = async () => { networkCalls++; throw new Error('publication is absent in this fixture'); };
  const result = await prepareMaintenanceChild(env, { establishOperatorPin: true, fetchImpl });
  assert.equal(networkCalls, 0); assert.deepEqual(env, before);
  assert.equal(result.env.FOXXI_LRS_NATIVE_POD_URL, env.FOXXI_TENANT_POD_URL);
  assert.equal(result.env.FOXXI_LRS_NATIVE_OWNER, env.FOXXI_AUTHORITATIVE_SOURCE);
  assert.equal(result.env.FOXXI_LRS_NATIVE_CAPABILITY, env.FOXXI_POD_WRITE_SECRET);
  assert.equal(result.env.FOXXI_LRS_NATIVE_PRIVATE_KEY, env.FOXXI_BRIDGE_PRIVATE_KEY);
  assert.equal(result.env.FOXXI_LRS_NATIVE_OWNER_PUBLIC_KEY, deriveAdminKeyPair(env.FOXXI_ADMIN_KEY_SEED).publicKey);
  assert.equal(result.assurance.assurance, 'operator-established pin from preexisting container configuration');
  for (const flag of ['ownerKeyDerivationRepeatable', 'stableBridgeRecipientDerivationRepeatable',
    'ownerDecryptedSyntheticNativeArtifact', 'stableBridgeRecipientDecryptedSyntheticNativeArtifact',
    'nativeArtifactBytesAndDigestVerified', 'configurationAppliedToMaintenanceChildOnly']) assert.equal(result.assurance[flag], true);
  for (const flag of ['historicalPublicationVerified', 'webIdControlProven', 'nativeWriteAuthorityProven']) assert.equal(result.assurance[flag], false);
  const printed = JSON.stringify(result.assurance);
  for (const secret of [env.FOXXI_ADMIN_KEY_SEED, env.FOXXI_POD_WRITE_SECRET, env.FOXXI_BRIDGE_PRIVATE_KEY,
    result.env.FOXXI_LRS_NATIVE_OWNER_PUBLIC_KEY]) assert.equal(printed.includes(secret), false);
  assert.match(result.assurance.ownerKeyFingerprintSha256, /^[a-f0-9]{64}$/);
  const repeat = await prepareMaintenanceChild(env, { establishOperatorPin: true, fetchImpl });
  assert.equal(repeat.assurance.ownerKeyFingerprintSha256, result.assurance.ownerKeyFingerprintSha256);
  assert.equal(repeat.assurance.stableBridgeRecipientFingerprintSha256, result.assurance.stableBridgeRecipientFingerprintSha256);
});

test('explicit mode refuses an existing different owner pin and invalid existing bridge key', async () => {
  await assert.rejects(prepareMaintenanceChild({ ...environment(), FOXXI_LRS_NATIVE_OWNER_PUBLIC_KEY: 'conflicting-existing-pin' },
    { establishOperatorPin: true }), /existing-native-owner-pin-conflict/);
  await assert.rejects(prepareMaintenanceChild({ ...environment(), FOXXI_BRIDGE_PRIVATE_KEY: 'invalid-key' },
    { establishOperatorPin: true }), /invalid-existing-bridge-private-key/);
});

test('default path retains publication+directory requirement; explicit flag never reaches importer arguments', async () => {
  let calls = 0;
  await assert.rejects(prepareMaintenanceChild({ ...environment(), FOXXI_ADMIN_WEB_ID: 'https://native.test/admin#me' },
    { fetchImpl: async () => { calls++; return new Response('', { status: 404 }); } }), /owner-custody-section-absent/);
  assert.ok(calls > 0);
  assert.deepEqual(parseWrapperArguments(['--establish-operator-pin', '--archive', '/private/source.json', '--apply']),
    { establishOperatorPin: true, childArguments: ['--archive', '/private/source.json', '--apply'] });
  assert.deepEqual(parseWrapperArguments(['--establish-operator-pin', '--omit-legacy-undefined-properties', '--archive', '/private/source.json']),
    { establishOperatorPin: true, childArguments: ['--omit-legacy-undefined-properties', '--archive', '/private/source.json'] });
  assert.throws(() => parseWrapperArguments(['--establish-operator-pin', '--establish-operator-pin']), /duplicate-operator-pin-mode/);
});

test('synthetic native-envelope owner custody is distinct from an unrelated key', () => {
  const env = environment(), owner = deriveAdminKeyPair(env.FOXXI_ADMIN_KEY_SEED),
    sender = deriveEncryptionKeyPair(env.FOXXI_BRIDGE_PRIVATE_KEY, env.FOXXI_AUTHORITATIVE_SOURCE),
    unrelated = deriveAdminKeyPair('synthetic-unrelated-seed');
  const envelope = createEncryptedEnvelope('synthetic-local-proof', [owner.publicKey, sender.publicKey], sender);
  assert.equal(openEncryptedEnvelope(envelope, owner), 'synthetic-local-proof');
  assert.equal(openEncryptedEnvelope(envelope, sender), 'synthetic-local-proof');
  assert.equal(openEncryptedEnvelope(envelope, unrelated), null);
});

test('opt-in public pin artifact contains only public configuration, is private-mode and cannot overwrite an archive', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'operator-pin-fixture-'));
  try {
    const { env, assurance } = await prepareMaintenanceChild(environment(), { establishOperatorPin: true });
    const path = join(directory, 'operator-pin.public.json');
    const receipt = await writePublicOperatorPin(path, env, assurance);
    assert.equal(receipt.publicOperatorPinWritten, true);
    const raw = await readFile(path, 'utf8'), published = JSON.parse(raw);
    assert.equal(published.ownerPublicKey, env.FOXXI_LRS_NATIVE_OWNER_PUBLIC_KEY);
    assert.equal(published.establishedFromExistingConfiguration, true);
    for (const value of [env.FOXXI_ADMIN_KEY_SEED, env.FOXXI_BRIDGE_PRIVATE_KEY, env.FOXXI_POD_WRITE_SECRET]) assert.equal(raw.includes(value), false);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await writePublicOperatorPin(path, env, assurance)).publicOperatorPinAlreadyIdentical, true);
    const archive = join(directory, 'encrypted-archive.json'); await writeFile(archive, 'preserved-encrypted-source');
    await assert.rejects(writePublicOperatorPin(archive, env, assurance), /operator-pin-output-exists-with-different-content/);
    assert.equal(await readFile(archive, 'utf8'), 'preserved-encrypted-source');
    assert.deepEqual(parseWrapperArguments(['--establish-operator-pin', '--operator-pin-output', path, '--archive', archive]),
      { establishOperatorPin: true, operatorPinOutput: path, childArguments: ['--archive', archive] });
    assert.throws(() => parseWrapperArguments(['--operator-pin-output', path]), /public-pin-output-requires-explicit-mode/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
