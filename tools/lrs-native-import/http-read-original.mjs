#!/usr/bin/env node
/** Optional existing-credential GET only. Never creates credentials, identities or statements. */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { decryptSnapshot, parseArguments } from './import.mjs';

function configuredPairs(environment) {
  const live = new Map();
  for (const raw of (environment.FOXXI_LRS_BASIC_AUTH_PAIRS ?? '').split(',').map(value => value.trim()).filter(Boolean)) {
    const parts = raw.split(':'); if (parts.length < 2) continue;
    const principal = parts[0], secret = parts[1];
    const tenant = (parts.slice(2).join(':').trim().replace(/\/+$/, '').toLowerCase()) || 'default';
    // Mirror the actual environment-seeded registry's replacement identity, without printing it.
    live.set('cred-' + Buffer.from(principal + ':' + tenant).toString('base64url').slice(0, 24), { principal, secret, tenant });
  }
  return [...live.values()];
}
const skipped = () => ({ httpOriginalReadVerified: false, skipped: true, existingMatchingCredentialAvailable: false });

export async function readOriginalThroughExistingHttp(source, environment = process.env, fetchImpl = globalThis.fetch) {
  let selected;
  for (const pair of configuredPairs(environment)) {
    const row = source.records.find(record => record.tenant === pair.tenant && !record.original.voided);
    if (row) { selected = { pair, row }; break; }
  }
  if (!selected) return skipped();
  const port = environment.PORT || '6080';
  if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error('invalid configured local port');
  const { pair, row } = selected, expected = row.original.statement;
  const url = new URL('http://127.0.0.1:' + port + '/xapi/statements');
  url.searchParams.set('statementId', row.id); url.searchParams.set('format', 'exact');
  const response = await fetchImpl(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(30000),
    headers: { Accept: 'application/json', 'X-Experience-API-Version': '2.0.0',
      Authorization: 'Basic ' + Buffer.from(pair.principal + ':' + pair.secret).toString('base64') } });
  if (response.status !== 200) throw new Error('existing credential HTTP read refused');
  const actual = JSON.parse(await response.text());
  const statementBodyExact = JSON.stringify(actual) === JSON.stringify(expected);
  const storedAuthorityExact = actual.stored === expected.stored && JSON.stringify(actual.authority) === JSON.stringify(expected.authority);
  const lastModifiedExact = response.headers.get('last-modified') === new Date(expected.stored).toUTCString();
  const versionExact = response.headers.get('x-experience-api-version') === '2.0.0';
  if (!statementBodyExact || !storedAuthorityExact || !lastModifiedExact || !versionExact) throw new Error('HTTP original fidelity mismatch');
  return { httpOriginalReadVerified: true, skipped: false, existingMatchingCredentialAvailable: true,
    existingConfiguredCredentialUsed: true, statementBodyExact, storedAuthorityExact, lastModifiedExact, versionExact };
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  if (args.has('--apply') || args.has('--offline')) throw new Error('HTTP verifier is GET only');
  const path = args.get('--archive'), expected = args.get('--expect-source-sha');
  if (!path || !/^[a-f0-9]{64}$/.test(expected ?? '')) throw new Error('archive and expected source required');
  if (!configuredPairs(process.env).length) { console.log(JSON.stringify(skipped())); return; }
  const source = decryptSnapshot(await readFile(resolve(path), 'utf8'), process.env.FOXXI_ADMIN_KEY_SEED,
    { omitLegacyUndefinedProperties: args.get('--omit-legacy-undefined-properties') === true });
  if (source.targetSourceSha256 !== expected) throw new Error('source script mismatch');
  console.log(JSON.stringify(await readOriginalThroughExistingHttp(source)));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => {
  console.error(JSON.stringify({ httpOriginalReadVerified: false, skipped: false, httpReadFailed: true }));
  process.exitCode = 1;
});
