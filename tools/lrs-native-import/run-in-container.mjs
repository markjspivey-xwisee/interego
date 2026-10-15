#!/usr/bin/env node
/** Inherit existing container secrets; derive/use them internally, never export or print their values. */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { deriveAdminKeyPair, TENANT_TYPES, discover, fetchGraphContent,
  parseDistributionFromDescriptorTurtle, parseTrig } from './runtime.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const required = ['FOXXI_TENANT_POD_URL', 'FOXXI_AUTHORITATIVE_SOURCE', 'FOXXI_ADMIN_WEB_ID',
  'FOXXI_ADMIN_KEY_SEED', 'FOXXI_POD_WRITE_SECRET', 'FOXXI_BRIDGE_PRIVATE_KEY'];
const fail = code => { throw Object.assign(new Error(code), { safeCode: code }); };
try {
  for (const key of required) if (!process.env[key]) fail('required-existing-container-configuration-missing');
  const env = { ...process.env };
  const pod = new URL(env.FOXXI_TENANT_POD_URL);
  if (pod.protocol !== 'https:' || pod.username || pod.password || pod.search || pod.hash || !pod.pathname.endsWith('/')) fail('invalid-existing-pod-scope');
  const keypair = deriveAdminKeyPair(env.FOXXI_ADMIN_KEY_SEED);
  const samePodFetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== pod.origin || !url.pathname.startsWith(pod.pathname) || url.search || url.hash || url.username || url.password
      || /%2e|%2f|%5c/i.test(url.pathname)) fail('owner-custody-read-left-pod');
    const headers = new Headers(init?.headers); headers.set('Authorization', 'Bearer ' + env.FOXXI_POD_WRITE_SECRET);
    const response = await fetch(url, { ...init, headers, redirect: 'manual', signal: AbortSignal.timeout(15000) });
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
  if (env.FOXXI_LRS_NATIVE_OWNER_PUBLIC_KEY && env.FOXXI_LRS_NATIVE_OWNER_PUBLIC_KEY !== keypair.publicKey) fail('existing-native-owner-pin-conflict');
  if (env.FOXXI_LRS_NATIVE_OWNER && env.FOXXI_LRS_NATIVE_OWNER !== env.FOXXI_AUTHORITATIVE_SOURCE) fail('existing-native-owner-scope-conflict');
  if (env.FOXXI_LRS_NATIVE_POD_URL && new URL(env.FOXXI_LRS_NATIVE_POD_URL).href !== pod.href) fail('existing-native-pod-scope-conflict');
  Object.assign(env, { FOXXI_LRS_BACKEND: 'interego', FOXXI_LRS_NATIVE_POD_URL: pod.href,
    FOXXI_LRS_NATIVE_OWNER: env.FOXXI_AUTHORITATIVE_SOURCE, FOXXI_LRS_NATIVE_CAPABILITY: env.FOXXI_POD_WRITE_SECRET,
    FOXXI_LRS_NATIVE_PRIVATE_KEY: env.FOXXI_BRIDGE_PRIVATE_KEY, FOXXI_LRS_NATIVE_OWNER_PUBLIC_KEY: keypair.publicKey });
  console.log(JSON.stringify({ ownerKeyMatchesExistingPublication: true, existingDirectoryReadback: true,
    encryptedDirectoryCustodyProven: true, configuredOwnerAttributionMatched: true,
    configurationAppliedToMaintenanceChildOnly: true, applicationProcessUnchanged: true }));
  const child = spawn(process.execPath, [resolve(here, 'import.mjs'), ...process.argv.slice(2)], {
    env, stdio: 'inherit', cwd: process.cwd(), shell: false,
  });
  child.on('error', () => { console.error(JSON.stringify({ ok: false, code: 'maintenance-child-failed', cutoverReady: false })); process.exitCode = 1; });
  child.on('exit', (code, signal) => { process.exitCode = signal ? 1 : code ?? 1; });
} catch (error) {
  console.error(JSON.stringify({ ok: false, code: error.safeCode || 'existing-owner-binding-verification-failed', cutoverReady: false }));
  process.exitCode = 1;
}
