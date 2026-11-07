import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { IRI } from '@interego/core';
import { readLegacySnapshotFailureWitness, FOXXI_SNAPSHOT_TYPES } from '../src/pod-snapshot-publisher.js';
import { isPlatformSnapshot } from '../src/lti-platform-readiness.js';

const base = 'https://pod.example/tenant/foxxi/snapshots/';
const headUrl = base + 'lti-platform-snapshot.ttl', graphUrl = base + 'lti-platform-snapshot-graph.trig';
const source = 'did:web:tenant.example' as IRI, type = FOXXI_SNAPSHOT_TYPES.LtiPlatformGradebook;
const iep = 'https://markjspivey-xwisee.github.io/interego/ns/iep#';
const fox = 'https://foxxi-bridge.interego.xwisee.com/ns/foxxi#';
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
function head(version = 2, target = graphUrl) {
  return `<urn:foxxi:lti-platform-snapshot:v${version}#descriptor> a <${iep}ContextDescriptor> ;
    <http://purl.org/dc/terms/conformsTo> <${type}> ; <${iep}describes> <urn:foxxi:lti-platform-snapshot:v${version}> .
    <> <${iep}affordance> [ <${iep}action> <${iep}canFetchPayload> ;
      <http://www.w3.org/ns/hydra/core#target> <${target}> ; <http://www.w3.org/ns/hydra/core#method> "GET" ;
      <http://www.w3.org/ns/dcat#accessURL> <${target}> ; <http://www.w3.org/ns/dcat#mediaType> "application/trig" ; <${iep}encrypted> false ] .`;
}
function graph(owner = source, digest?: string, version = 1) {
  const value = JSON.stringify({ lineItems: [], results: [], members: [] });
  return `<urn:foxxi:lti-platform-snapshot:v1> a <${type}> ;
    <http://www.w3.org/ns/prov#wasAttributedTo> <${owner}> ;
    <http://purl.org/dc/terms/identifier> "sha256:${digest ?? hash(value)}" ;
    <${fox}snapshotVersion> "${version}" ; <${fox}bundleJson> "${Buffer.from(value).toString('base64')}" .`;
}
function fixture(options: { head?: string; graph?: string; etag?: string | null; moveHead?: boolean; moveGraph?: boolean; status?: number } = {}) {
  const calls: Array<{ url: string; init?: RequestInit }> = []; let heads = 0, graphs = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input); calls.push({ url, init });
    expect(init?.method ?? 'GET').toBe('GET');
    expect([headUrl, graphUrl]).toContain(url);
    if (url === headUrl) heads++; else graphs++;
    const body = url === headUrl ? options.head ?? head() : options.graph ?? graph();
    const moved = url === headUrl ? options.moveHead && heads > 1 : options.moveGraph && graphs > 1;
    return new Response(body, { status: options.status ?? 200, headers: options.etag === null ? {}
      : { etag: moved ? '"changed-resource"' : options.etag ?? '"stable-resource"' } });
  };
  const read = (now = 1000) => readLegacySnapshotFailureWitness('lti-platform', {
    config: { podUrl: 'https://pod.example/tenant/', authoritativeSource: source, fetch: fetcher },
    typeIri: type, validate: isPlatformSnapshot, now: () => now,
  });
  return { calls, read };
}

describe('read-only legacy LTI failure witness', () => {
  it('witnesses stable valid mismatched bytes without publishing or disclosing the payload', async () => {
    const f = fixture(), result = await f.read();
    expect(result).toMatchObject({ schemaVersion: '1.0.0', reason: 'legacy-head-mismatch',
      expectedGraphIri: 'urn:foxxi:lti-platform-snapshot:v2', actualGraphIri: 'urn:foxxi:lti-platform-snapshot:v1',
      descriptorSha256: hash(head()), graphSha256: hash(graph()), observedAt: new Date(1000).toISOString() });
    expect(result.witnessDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(f.calls).toHaveLength(4);
    for (const { init } of f.calls) { expect(init?.redirect).toBe('manual'); expect(init?.cache).toBe('no-store'); }
    expect(JSON.stringify(result)).not.toContain('bundleJson');
    expect(JSON.stringify(result)).not.toContain('lineItems');
    expect((await f.read(2000)).witnessDigest).toBe(result.witnessDigest);
  });

  it('refuses movement of either resource during the observation', async () => {
    for (const options of [{ moveHead: true }, { moveGraph: true }]) {
      await expect(fixture(options).read()).rejects.toThrow('could not be independently witnessed');
    }
  });

  it('refuses missing/weak revisions, HTTP failures and forged or malformed payloads', async () => {
    for (const options of [{ etag: null }, { etag: 'W/"weak"' }, { status: 503 },
      { graph: graph('did:web:foreign.example' as IRI) }, { graph: graph(source, '0'.repeat(64)) },
      { graph: graph(source, undefined, 2) }, { graph: 'unparseable' }, { head: 'unparseable' },
      { head: head(1) }, { head: head(2, 'https://foreign.example/graph') }]) {
      await expect(fixture(options).read()).rejects.toThrow('could not be independently witnessed');
    }
  });

  it('refuses an oversized descriptor before parsing and exposes only a fixed failure', async () => {
    await expect(fixture({ head: 'private-marker'.repeat(100_000) }).read())
      .rejects.toThrow('The existing LTI failure could not be independently witnessed.');
  });
});
