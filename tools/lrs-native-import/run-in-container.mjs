#!/usr/bin/env node
/** Inherit existing container secrets; derive/use them internally, never export or print their values. */
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, open, readFile } from 'node:fs/promises';
import { deriveAdminKeyPair, TENANT_TYPES, discover, fetchGraphContent,
  parseDistributionFromDescriptorTurtle, parseTrig, deriveEncryptionKeyPair,
  createEncryptedEnvelope, openEncryptedEnvelope, createNativeByteArtifact, readNativeByteArtifact } from './runtime.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fail = code => { throw Object.assign(new Error(code), { safeCode: code }); };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).filter(k => value[k] !== undefined).sort()
    .map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
};

export function parseWrapperArguments(args) {
  if (args.filter(a => a === '--establish-operator-pin').length > 1) fail('duplicate-operator-pin-mode');
  const childArguments = []; let operatorPinOutput;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--establish-operator-pin') continue;
    if (args[i] === '--operator-pin-output') {
      if (operatorPinOutput || !args[i + 1] || args[i + 1].startsWith('--')) fail('invalid-operator-pin-output-argument');
      operatorPinOutput = args[++i]; continue;
    }
    childArguments.push(args[i]);
  }
  const establishOperatorPin = args.includes('--establish-operator-pin');
  if (operatorPinOutput && !establishOperatorPin) fail('public-pin-output-requires-explicit-mode');
  return { establishOperatorPin, childArguments, ...(operatorPinOutput ? { operatorPinOutput } : {}) };
}

/** Public configuration artifact only; create-only writes cannot replace an archive, checkpoint or code. */
export async function writePublicOperatorPin(path, env, assurance) {
  const value = { schema: 'interego-operator-established-native-pin-v1',
    pod: env.FOXXI_LRS_NATIVE_POD_URL, owner: env.FOXXI_LRS_NATIVE_OWNER,
    ownerPublicKey: env.FOXXI_LRS_NATIVE_OWNER_PUBLIC_KEY,
    ownerKeyFingerprintSha256: assurance.ownerKeyFingerprintSha256,
    stableBridgeRecipientFingerprintSha256: assurance.stableBridgeRecipientFingerprintSha256,
    establishedFromExistingConfiguration: true,
    assurance: 'operator-established pin from preexisting container configuration' };
  const data = JSON.stringify(value, null, 2), target = resolve(path);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  let handle;
  try { handle = await open(target, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (await readFile(target, 'utf8') !== data) fail('operator-pin-output-exists-with-different-content');
    return { publicOperatorPinWritten: false, publicOperatorPinAlreadyIdentical: true, publicOperatorPinSha256: sha(data) };
  }
  try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
  const directory = await open(dirname(target), 'r'); try { await directory.sync(); } finally { await directory.close(); }
  return { publicOperatorPinWritten: true, publicOperatorPinAlreadyIdentical: false, publicOperatorPinSha256: sha(data) };
}

/** Explicit operator configuration pin, verified for local custody; it makes no historical identity/publication claim. */
function establishConfiguredPin(env, keypair) {
  const again = deriveAdminKeyPair(env.FOXXI_ADMIN_KEY_SEED);
  if (again.publicKey !== keypair.publicKey || again.secretKey !== keypair.secretKey) fail('owner-key-derivation-not-repeatable');
  const sender = deriveEncryptionKeyPair(env.FOXXI_BRIDGE_PRIVATE_KEY, env.FOXXI_AUTHORITATIVE_SOURCE);
  const senderAgain = deriveEncryptionKeyPair(env.FOXXI_BRIDGE_PRIVATE_KEY, env.FOXXI_AUTHORITATIVE_SOURCE);
  if (senderAgain.publicKey !== sender.publicKey || senderAgain.secretKey !== sender.secretKey) fail('bridge-recipient-derivation-not-repeatable');
  const proofBytes = Buffer.from('interego-native-lrs:operator-established-pin:local-custody-proof:v1');
  const contentType = 'application/vnd.interego.operator-pin-proof';
  const artifact = createNativeByteArtifact({ owner: env.FOXXI_AUTHORITATIVE_SOURCE, contentType, bytes: proofBytes,
    provenance: { wasAttributedTo: env.FOXXI_AUTHORITATIVE_SOURCE, generatedAtTime: '2026-10-15T00:00:00.000Z' } });
  // Exactly the native canonical plaintext representation, encrypted with its actual envelope primitive.
  const plaintext = canonical({ topUri: artifact.topUri, nodes: Object.fromEntries(artifact.pgsl.nodes) });
  const recipients = [...new Set([keypair.publicKey, sender.publicKey])].sort();
  const envelope = createEncryptedEnvelope(plaintext, recipients, sender);
  if (canonical(envelope.wrappedKeys.map(k => k.recipientPublicKey).sort()) !== canonical(recipients)) fail('operator-pin-recipient-policy-mismatch');
  for (const recipient of [keypair, sender]) {
    const opened = openEncryptedEnvelope(envelope, recipient);
    if (opened !== plaintext) fail('operator-pin-local-decryption-failed');
    const parsed = JSON.parse(opened);
    const recovered = readNativeByteArtifact({ topUri: parsed.topUri, nodes: new Map(Object.entries(parsed.nodes)) });
    if (recovered.owner !== env.FOXXI_AUTHORITATIVE_SOURCE || recovered.contentType !== contentType
      || !Buffer.from(recovered.bytes).equals(proofBytes) || recovered.sha256 !== 'sha256:' + sha(proofBytes)) fail('operator-pin-native-artifact-proof-failed');
  }
  return {
    assurance: 'operator-established pin from preexisting container configuration',
    ownerKeyFingerprintSha256: sha(Buffer.from(keypair.publicKey, 'base64')),
    stableBridgeRecipientFingerprintSha256: sha(Buffer.from(sender.publicKey, 'base64')),
    ownerKeyDerivationRepeatable: true, stableBridgeRecipientDerivationRepeatable: true,
    ownerDecryptedSyntheticNativeArtifact: true, stableBridgeRecipientDecryptedSyntheticNativeArtifact: true,
    nativeArtifactBytesAndDigestVerified: true, ownerScopeFromPreexistingConfiguration: true,
    existingTenantPodReused: true, existingWriteCapabilityReused: true,
    historicalPublicationVerified: false, webIdControlProven: false,
    nativeWriteAuthorityProven: false,
  };
}

export async function prepareMaintenanceChild(existingEnvironment, { establishOperatorPin = false, fetchImpl = globalThis.fetch } = {}) {
  const env = { ...existingEnvironment };
  const required = ['FOXXI_TENANT_POD_URL', 'FOXXI_AUTHORITATIVE_SOURCE', 'FOXXI_ADMIN_KEY_SEED',
    'FOXXI_POD_WRITE_SECRET', 'FOXXI_BRIDGE_PRIVATE_KEY', ...(establishOperatorPin ? [] : ['FOXXI_ADMIN_WEB_ID'])];
  for (const key of required) if (typeof env[key] !== 'string' || !env[key]) fail('required-existing-container-configuration-missing');
  if (!/^(?:0x)?[a-fA-F0-9]{64}$/.test(env.FOXXI_BRIDGE_PRIVATE_KEY)) fail('invalid-existing-bridge-private-key');
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:[^\s]+$/.test(env.FOXXI_AUTHORITATIVE_SOURCE)
    || env.FOXXI_AUTHORITATIVE_SOURCE.length > 4096) fail('invalid-existing-owner-scope');
  const pod = new URL(env.FOXXI_TENANT_POD_URL);
  if (pod.protocol !== 'https:' || pod.username || pod.password || pod.search || pod.hash || !pod.pathname.endsWith('/')
    || /%2e|%2f|%5c/i.test(pod.pathname)) fail('invalid-existing-pod-scope');
  const keypair = deriveAdminKeyPair(env.FOXXI_ADMIN_KEY_SEED);
  let assurance;
  if (establishOperatorPin) assurance = establishConfiguredPin(env, keypair);
  else {
    const samePodFetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.origin !== pod.origin || !url.pathname.startsWith(pod.pathname) || url.search || url.hash || url.username || url.password
        || /%2e|%2f|%5c/i.test(url.pathname)) fail('owner-custody-read-left-pod');
      const headers = new Headers(init?.headers); headers.set('Authorization', 'Bearer ' + env.FOXXI_POD_WRITE_SECRET);
      const response = await fetchImpl(url, { ...init, headers, redirect: 'manual', signal: AbortSignal.timeout(15000) });
      if (response.status >= 300 && response.status < 400) fail('owner-custody-read-redirected');
      return response;
    };
    const entries = await discover(pod.href, undefined, { fetch: samePodFetch });
    const provenance = 'http://www.w3.org/ns/prov#wasAttributedTo';
    const attributed = doc => doc.subjects.some(subject => (subject.properties.get(provenance) ?? [])
      .some(term => term.kind === 'iri' && term.iri === env.FOXXI_AUTHORITATIVE_SOURCE));
    const readSection = async (type, requireEncrypted) => {
      const local = type.split(/[#/]/).pop();
      const matching = entries.filter(e => e.conformsTo?.some(t => t.split(/[#/]/).pop() === local))
        .sort((a, b) => (b.validFrom ?? '').localeCompare(a.validFrom ?? ''));
      if (!matching.length) fail('owner-custody-section-absent');
      const response = await samePodFetch(matching[0].descriptorUrl, { headers: { Accept: 'text/turtle' } });
      if (!response.ok) fail('owner-custody-descriptor-unreadable');
      const turtle = await response.text();
      if (!attributed(parseTrig(turtle))) fail('owner-custody-descriptor-attribution-mismatch');
      const distribution = parseDistributionFromDescriptorTurtle(turtle);
      if (!distribution) fail('owner-custody-distribution-missing');
      const graph = await fetchGraphContent(distribution.accessURL, { fetch: samePodFetch, recipientKeyPair: keypair });
      if (!graph.content || (requireEncrypted && !graph.encrypted)) fail('owner-custody-encrypted-readback-failed');
      const document = parseTrig(graph.content);
      if (!attributed(document)) fail('owner-custody-graph-attribution-mismatch');
      const payloads = document.subjects.flatMap(subject => [...subject.properties]
        .filter(([predicate]) => predicate.endsWith('#bundleJson'))
        .flatMap(([, terms]) => terms.filter(term => term.kind === 'literal').map(term => term.value)));
      if (payloads.length !== 1) fail('owner-custody-bundle-ambiguous');
      return JSON.parse(Buffer.from(payloads[0], 'base64').toString('utf8'));
    };
    const published = await readSection(TENANT_TYPES.AdminEncryptionKey, false);
    if (!published || published.admin_web_id !== env.FOXXI_ADMIN_WEB_ID
      || published.algorithm !== 'X25519-XSalsa20-Poly1305' || published.public_key_base64 !== keypair.publicKey) fail('existing-owner-public-key-binding-failed');
    const directory = await readSection(TENANT_TYPES.TenantDirectory, true);
    if (!directory || !Array.isArray(directory.users) || !directory.users.some(u => u?.web_id === env.FOXXI_ADMIN_WEB_ID)) fail('existing-owner-directory-readback-failed');
    assurance = { assurance: 'verified existing publication and encrypted directory custody',
      ownerKeyMatchesExistingPublication: true, existingDirectoryReadback: true, encryptedDirectoryCustodyProven: true,
      configuredOwnerAttributionMatched: true, nativeWriteAuthorityProven: false };
  }
  if (env.FOXXI_LRS_NATIVE_OWNER_PUBLIC_KEY && env.FOXXI_LRS_NATIVE_OWNER_PUBLIC_KEY !== keypair.publicKey) fail('existing-native-owner-pin-conflict');
  if (env.FOXXI_LRS_NATIVE_OWNER && env.FOXXI_LRS_NATIVE_OWNER !== env.FOXXI_AUTHORITATIVE_SOURCE) fail('existing-native-owner-scope-conflict');
  if (env.FOXXI_LRS_NATIVE_POD_URL && new URL(env.FOXXI_LRS_NATIVE_POD_URL).href !== pod.href) fail('existing-native-pod-scope-conflict');
  Object.assign(env, { FOXXI_LRS_BACKEND: 'interego', FOXXI_LRS_NATIVE_POD_URL: pod.href,
    FOXXI_LRS_NATIVE_OWNER: env.FOXXI_AUTHORITATIVE_SOURCE, FOXXI_LRS_NATIVE_CAPABILITY: env.FOXXI_POD_WRITE_SECRET,
    FOXXI_LRS_NATIVE_PRIVATE_KEY: env.FOXXI_BRIDGE_PRIVATE_KEY, FOXXI_LRS_NATIVE_OWNER_PUBLIC_KEY: keypair.publicKey });
  return { env, assurance: { ...assurance, configurationAppliedToMaintenanceChildOnly: true, applicationProcessUnchanged: true } };
}

async function main() {
  try {
    const { establishOperatorPin, childArguments, operatorPinOutput } = parseWrapperArguments(process.argv.slice(2));
    const { env, assurance } = await prepareMaintenanceChild(process.env, { establishOperatorPin });
    const pinReceipt = operatorPinOutput ? await writePublicOperatorPin(operatorPinOutput, env, assurance) : {};
    console.log(JSON.stringify({ ...assurance, ...pinReceipt }));
    const child = spawn(process.execPath, [resolve(here, 'import.mjs'), ...childArguments], {
      env, stdio: 'inherit', cwd: process.cwd(), shell: false,
    });
    child.on('error', () => { console.error(JSON.stringify({ ok: false, code: 'maintenance-child-failed', cutoverReady: false })); process.exitCode = 1; });
    child.on('exit', (code, signal) => { process.exitCode = signal ? 1 : code ?? 1; });
  } catch (error) {
    console.error(JSON.stringify({ ok: false, code: error.safeCode || 'existing-owner-binding-verification-failed', cutoverReady: false }));
    process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
