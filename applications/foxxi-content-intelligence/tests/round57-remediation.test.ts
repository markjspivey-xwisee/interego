/**
 * Round-57 — the SCORM upload affordance parsed nothing, and said a runner would.
 *
 * `foxxi.upload_scorm_package` read four bytes of the zip for a PK header, published a
 * descriptor carrying the package's SIZE and `status: 'queued'`, and deferred the parse
 * to "a separate Azure Function deploy". No such runner exists in this repo; nothing
 * anywhere reads a fxs:PackageUpload descriptor; the Azure host it named is retired.
 * Reproduced against an in-memory pod: a real SCORM 2004 zip titled "Forklift Safety
 * Refresher" with two SCOs and Articulate Storyline tell-tales published a graph whose
 * ENTIRE payload was {packageId,hintedTitle,sizeBytes,uploadedAt,uploaderDid,
 * status:"queued"}, and the iep:supersedes promotion advertised on the live /affordances
 * manifest never happened.
 *
 * ★ WHAT IS AND IS NOT DOUBLED HERE. The parse is REAL — this file builds a real zip and
 * uploadScormPackage runs unwrapScormPackage + fingerprintAuthoringTool +
 * manifestToAgenticCourse over it. Only the pod is a double, and it records verbatim the
 * bytes the fix must produce, so it can express the failure: under the old implementation
 * no `-parsed.ttl` is written at all and `result.parsed` is undefined.
 */
import { describe, it, expect } from 'vitest';
import AdmZip from 'adm-zip';
import { Wallet } from 'ethers';
import { createHash } from 'node:crypto';
import {
  uploadScormPackage,
  declaredUncompressedBytes,
  uncompressedBudget,
} from '../src/composed-extensions.js';
import { foxxiAffordances, foxxiAdminAffordances } from '../affordances.js';
import { FOXXI_TERMS, FOXXI_NS } from '../src/foxxi-vocab.js';
import { FederationOutcomeLoader } from '../src/federation-outcome-loader.js';
import { gateWriteFetch } from '../src/gate-write-fetch.js';

const POD = 'https://pod.example/foxxi/';

/** An in-memory LDP pod. No globals are touched — vitest runs every file in ONE
 *  globalThis here, and a stubbed global fetch would leak into unrelated files. */
function inMemoryPod() {
  const store = new Map<string, string>();
  const fetchFn = (async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const url = String(typeof input === 'string' ? input : (input as { url: string }).url);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'PUT' || method === 'POST' || method === 'PATCH') {
      store.set(url, String(init?.body ?? ''));
      return new Response('', { status: 201, headers: { Location: url } });
    }
    const body = store.get(url);
    return body === undefined
      ? new Response('not found', { status: 404 })
      : new Response(body, { status: 200, headers: { 'Content-Type': 'text/turtle' } });
  }) as never;
  const find = (needle: string): string | undefined => [...store.entries()].find(([u]) => u.includes(needle))?.[1];
  return { store, fetchFn, find };
}

const MANIFEST = `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="com.articulate.storyline.demo" version="1.0"
  xmlns="http://www.imsglobal.org/xsd/imscp_v1p1"
  xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_v1p3">
  <metadata><schema>ADL SCORM</schema><schemaversion>2004 4th Edition</schemaversion></metadata>
  <organizations default="ORG"><organization identifier="ORG">
    <title>Forklift Safety Refresher</title>
    <item identifier="I1" identifierref="R1"><title>Pre-Operation Inspection</title></item>
    <item identifier="I2" identifierref="R2"><title>Load Handling</title></item>
  </organization></organizations>
  <resources>
    <resource identifier="R1" type="webcontent" adlcp:scormType="sco" href="story.html">
      <file href="story.html"/></resource>
    <resource identifier="R2" type="webcontent" adlcp:scormType="sco" href="mobile/index.html">
      <file href="mobile/index.html"/></resource>
  </resources>
</manifest>`;

function realScormZipBase64(): string {
  const zip = new AdmZip();
  zip.addFile('imsmanifest.xml', Buffer.from(MANIFEST, 'utf8'));
  zip.addFile('story.html', Buffer.from('<html><body>Pre-Operation Inspection</body></html>', 'utf8'));
  zip.addFile('story_content/frame.js', Buffer.from('//', 'utf8'));
  zip.addFile('html5/data/js/data.js', Buffer.from('{"projectId":"p1","courseId":"c1","version":"3.90.30800.0"}', 'utf8'));
  zip.addFile('mobile/index.html', Buffer.from('<html><body>Load Handling</body></html>', 'utf8'));
  return zip.toBuffer().toString('base64');
}

describe('round-57 — a SCORM upload is parsed on arrival, not queued for a runner', () => {
  it('reads the manifest, the standard, the SCOs and the authoring tool out of the zip', async () => {
    const pod = inMemoryPod();
    const r = await uploadScormPackage({
      tenantPodUrl: POD, zipBase64: realScormZipBase64(),
      hintedTitle: 'whatever the uploader typed', uploaderDid: 'did:ethr:0xADMIN', fetch: pod.fetchFn,
    });
    expect(r.status).toBe('parsed');
    expect(r.parsed, 'the old implementation returned no parse at all').toBeTruthy();
    // The manifest's title, not the uploader's hint.
    expect(r.parsed!.packageTitle).toBe('Forklift Safety Refresher');
    expect(r.parsed!.packageIdentifier).toBe('com.articulate.storyline.demo');
    expect(r.parsed!.standard.standard).toBe('SCORM 2004 4th Edition');
    expect(r.parsed!.format).toBe('scorm-2004');
    expect(r.parsed!.authoringTool.toolId).toBe('articulate-storyline');
    expect(r.parsed!.launchable).toEqual(expect.arrayContaining(['story.html', 'mobile/index.html']));
    expect(r.parsed!.structure.items.map(i => i.title))
      .toEqual(expect.arrayContaining(['Pre-Operation Inspection', 'Load Handling']));
  });

  it('the parsed descriptor is Asserted and supersedes the Hypothetical receipt', async () => {
    const pod = inMemoryPod();
    const r = await uploadScormPackage({
      tenantPodUrl: POD, zipBase64: realScormZipBase64(),
      uploaderDid: 'did:ethr:0xADMIN', fetch: pod.fetchFn,
    });
    const receiptTtl = pod.find(`${r.packageId}.ttl`);
    const parsedTtl = pod.find(`${r.packageId}-parsed.ttl`);
    expect(receiptTtl, 'the receipt must survive').toBeTruthy();
    expect(parsedTtl, 'no promotion descriptor was written').toBeTruthy();
    expect(receiptTtl!).toMatch(/iep:modalStatus iep:Hypothetical/);
    expect(parsedTtl!).toMatch(/iep:modalStatus iep:Asserted/);
    expect(parsedTtl!).toContain(`iep:supersedes <urn:foxxi:upload:${r.packageId}#descriptor>`);
    expect(parsedTtl!).toContain('ns/foxxi#ParsedPackage');
    // The old terminal state is gone: no descriptor still claims a queue.
    expect(receiptTtl! + parsedTtl!).not.toMatch(/queued/);
  });

  it('an unreadable zip fails loudly and asserts nothing about it', async () => {
    const pod = inMemoryPod();
    const noManifest = new AdmZip();
    noManifest.addFile('readme.txt', Buffer.from('not a course', 'utf8'));
    const r = await uploadScormPackage({
      tenantPodUrl: POD, zipBase64: noManifest.toBuffer().toString('base64'),
      uploaderDid: 'did:ethr:0xADMIN', fetch: pod.fetchFn,
    });
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/missing imsmanifest\.xml or cmi5\.xml/);
    expect(r.parsed).toBeUndefined();
    expect(pod.find(`${r.packageId}-parsed.ttl`), 'nothing may be Asserted about a package that could not be read').toBeUndefined();
    expect(pod.find(`${r.packageId}.ttl`), 'the receipt is the audit trail of a rejected upload').toMatch(/iep:modalStatus iep:Hypothetical/);
  });

  it('a decompression bomb is refused from the central directory, before inflating', async () => {
    const bomb = new AdmZip();
    bomb.addFile('imsmanifest.xml', Buffer.from(MANIFEST, 'utf8'));
    bomb.addFile('payload.bin', Buffer.alloc(16 * 1024 * 1024, 0));   // tiny zip, declares 16MB
    const buf = bomb.toBuffer();
    expect(declaredUncompressedBytes(buf)).toBeGreaterThan(uncompressedBudget(buf.length));

    const pod = inMemoryPod();
    const r = await uploadScormPackage({
      tenantPodUrl: POD, zipBase64: buf.toString('base64'),
      uploaderDid: 'did:ethr:0xADMIN', fetch: pod.fetchFn,
    });
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/decompression bomb/);
    expect(pod.find(`${r.packageId}-parsed.ttl`)).toBeUndefined();
  });

  it('the guard is not a blanket deny — an ordinary package is within budget', () => {
    const zip = new AdmZip();
    zip.addFile('imsmanifest.xml', Buffer.from(MANIFEST, 'utf8'));
    zip.addFile('a.html', Buffer.from('x'.repeat(200_000), 'utf8'));
    const buf = zip.toBuffer();
    expect(declaredUncompressedBytes(buf)).toBeLessThanOrEqual(uncompressedBudget(buf.length));
  });

  it('the affordance no longer promises a runner that does not exist', () => {
    const a = [...foxxiAffordances, ...foxxiAdminAffordances].find(x => x.toolName === 'foxxi.upload_scorm_package');
    expect(a).toBeTruthy();
    expect(a!.description, 'the retired Azure / Python runner must not be advertised')
      .not.toMatch(/Python parser|Azure|parser-runner|Queue a SCORM/i);
    expect(a!.description).toMatch(/in-process/i);
    expect(a!.description).toMatch(/supersedes/);
  });

  it('fxs:ParsedPackage is a declared, dereferenceable term', () => {
    expect(FOXXI_TERMS.some(t => t.name === 'ParsedPackage')).toBe(true);
  });
});

/**
 * Round-57 (second half) — an unprovisioned federation peer was invisible.
 *
 * ★ WHY. FOXXI_FEDERATION_PODS is SET in production and names
 * https://gate.interego.xwisee.com/foxxi/federation-peer/, which 404s. discover()
 * maps a 404 manifest to [] by design (a shard-only pod legitimately has no
 * monolith), so loadAll()'s catch never fired, nothing was ever logged, and
 * /performance/calibration reported `usingSeedFallback: true` — byte-identical to
 * what it reports when no peers are configured at all. 56 SAMPLE_PEER_OUTCOMES
 * samples were being served as `federated` evidence with no field saying so.
 *
 * The double here is a fake `fetch`. It CAN express every failure under test — it
 * can 404 a manifest, serve a manifest whose graph 404s, and serve a graph with no
 * signature — so it stands in for the network, not for the loader.
 */
const PEER = 'https://peer.example.test/foxxi/federation-peer/';
const OUTCOME_UID = 'aaaa';
const GRAPH_URL = `${PEER}foxxi/work-products/outcome-${OUTCOME_UID}-graph.trig`;

const PEER_MANIFEST = `@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#>.
@prefix dct: <http://purl.org/dc/terms/>.

<${PEER}context-graphs/outcome-${OUTCOME_UID}.ttl> a iep:ManifestEntry ;
    iep:describes <urn:foxxi:outcome:${OUTCOME_UID}> ;
    dct:conformsTo <${FOXXI_NS}Outcome> .
`;

const PAYLOAD = JSON.stringify({
  regime: 'Knowable', causeFactor: 'information', method: 'gap-analysis',
  intervention: 'performance-support', verdict: 'closed', source: 'peer',
});

function graphTurtle(opts: { signature?: string; author?: string }): string {
  const b64 = Buffer.from(PAYLOAD, 'utf8').toString('base64');
  return [
    `@prefix foxxi: <${FOXXI_NS}>.`,
    '@prefix prov: <http://www.w3.org/ns/prov#>.',
    '@prefix xsd: <http://www.w3.org/2001/XMLSchema#>.',
    '',
    `<urn:foxxi:outcome:${OUTCOME_UID}> foxxi:bundleJson "${b64}"^^xsd:base64Binary ;`,
    ...(opts.signature ? [`    foxxi:agentSignature "${opts.signature}" ;`] : []),
    ...(opts.author ? [`    prov:wasGeneratedBy <${opts.author}> ;`] : []),
    '    a foxxi:Outcome .',
  ].join('\n');
}

function fakePod(routes: Record<string, { status: number; body: string }>): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    const hit = routes[url];
    if (!hit) return new Response('not found', { status: 404, statusText: 'Not Found' });
    return new Response(hit.body, { status: hit.status, statusText: hit.status === 200 ? 'OK' : 'Error', headers: { 'Content-Type': 'text/turtle' } });
  }) as typeof globalThis.fetch;
}

describe('round-57 — a configured-but-absent federation peer reports itself', () => {
  it('an absent peer pod is REPORTED, not swallowed into an empty read', async () => {
    // Everything 404s, including .well-known/context-graphs — the live state.
    const loader = new FederationOutcomeLoader({ fetch: fakePod({}) });
    expect(await loader.loadAll([PEER])).toEqual([]);
    expect(loader.podStatuses()[PEER], 'a 404 peer must not look like a healthy empty one').toBe('no-manifest');
  });

  it('a peer that publishes only UNSIGNED outcomes is distinguishable from an absent one', async () => {
    const loader = new FederationOutcomeLoader({
      fetch: fakePod({
        [`${PEER}.well-known/context-graphs`]: { status: 200, body: PEER_MANIFEST },
        [GRAPH_URL]: { status: 200, body: graphTurtle({}) },
      }),
    });
    expect(await loader.loadAll([PEER])).toEqual([]);
    expect(loader.podStatuses()[PEER]).toBe('all-rejected');
  });

  it('a real signed peer outcome still reads as ok', async () => {
    // Guards against a "fix" that reports a fault for everything.
    const wallet = Wallet.createRandom();
    const did = `did:key:${wallet.address.toLowerCase()}`;
    const message = `sha256:${createHash('sha256').update(PAYLOAD, 'utf8').digest('hex')}`;
    const signature = await wallet.signMessage(message);
    const loader = new FederationOutcomeLoader({
      fetch: fakePod({
        [`${PEER}.well-known/context-graphs`]: { status: 200, body: PEER_MANIFEST },
        [GRAPH_URL]: { status: 200, body: graphTurtle({ signature, author: did }) },
      }),
    });
    const outcomes = await loader.loadAll([PEER]);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.verdict).toBe('closed');
    expect(loader.podStatuses()[PEER]).toBe('ok');
  });

  it('gateWriteFetch attaches the operator bearer on an EXACT-origin write only', async () => {
    const seen: Array<{ url: string; auth: string | null }> = [];
    const spy = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      seen.push({ url, auth: new Headers(init?.headers ?? {}).get('authorization') });
      return new Response('', { status: 201 });
    }) as typeof globalThis.fetch;

    const f = gateWriteFetch('https://gate.example/foxxi/peer/', 'S3CRET', spy);
    await f('https://gate.example/foxxi/peer/x.ttl', { method: 'PUT' });
    expect(seen[0]!.auth).toBe('Bearer S3CRET');

    // ★ startsWith would send the operator secret to an attacker-owned host.
    await f('https://gate.example.evil.tld/foxxi/peer/x.ttl', { method: 'PUT' });
    expect(seen[1]!.auth, 'the secret must never leave the exact configured origin').toBeNull();

    // Reads are never decorated, so the secret cannot ride along on a GET.
    await f('https://gate.example/foxxi/peer/x.ttl');
    expect(seen[2]!.auth).toBeNull();
  });
});
