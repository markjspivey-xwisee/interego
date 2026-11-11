/**
 * Anyone who signs may bring a package to be hosted, within bounds the deployment sets.
 *
 * ★ WHY. Only an admin could host a package (foxxi.upload_scorm_package), so a person or an agent
 * arriving with content, and no account, could play what was hosted but bring nothing. The signed
 * route takes the same upload from any key (src/open-hosting.ts), and these are its bounds.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { SignerHourlyLimit, base64CharsFor, openHostingRequest, openHostingSettings } from '../src/open-hosting.js';
import { foxxiAffordances } from '../affordances.js';

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');
const MB = 1024 * 1024;

describe('what a deployment allows', () => {
  it('is open by default, with a 25 MB package and five per signer per hour', () => {
    expect(openHostingSettings({})).toEqual({ enabled: true, maxZipBytes: 25 * MB, perSignerHourly: 5 });
    expect(openHostingSettings({ FOXXI_OPEN_HOSTING: ' ON ' }).enabled).toBe(true);
  });

  it('is closed by one switch, and honors the bounds it is given', () => {
    expect(openHostingSettings({ FOXXI_OPEN_HOSTING: 'off' }).enabled).toBe(false);
    expect(openHostingSettings({ FOXXI_OPEN_HOSTING_MAX_ZIP_MB: '8', FOXXI_OPEN_HOSTING_PER_SIGNER_HOURLY: '2' }))
      .toEqual({ enabled: true, maxZipBytes: 8 * MB, perSignerHourly: 2 });
  });

  it('stops on a setting it cannot honor, where a guess would open or close the route silently', () => {
    for (const env of [
      { FOXXI_OPEN_HOSTING: 'no' }, { FOXXI_OPEN_HOSTING: 'false' },
      { FOXXI_OPEN_HOSTING_MAX_ZIP_MB: '0' }, { FOXXI_OPEN_HOSTING_MAX_ZIP_MB: '38' }, { FOXXI_OPEN_HOSTING_MAX_ZIP_MB: '2.5' }, { FOXXI_OPEN_HOSTING_MAX_ZIP_MB: 'big' },
      { FOXXI_OPEN_HOSTING_PER_SIGNER_HOURLY: '0' }, { FOXXI_OPEN_HOSTING_PER_SIGNER_HOURLY: '1001' },
    ]) expect(() => openHostingSettings(env), JSON.stringify(env)).toThrow();
  });

  it('never allows a package the request body could not carry', () => {
    // The bridge reads at most 50 MB of JSON; the largest setting must fit it once base64-encoded.
    expect(base64CharsFor(openHostingSettings({ FOXXI_OPEN_HOSTING_MAX_ZIP_MB: '37' }).maxZipBytes)).toBeLessThan(50 * MB);
  });
});

describe('what a signed payload may ask to host', () => {
  const settings = openHostingSettings({ FOXXI_OPEN_HOSTING_MAX_ZIP_MB: '1' });
  it('takes a package of at most the size allowed, and trims its title', () => {
    const atLimit = 'A'.repeat(base64CharsFor(settings.maxZipBytes));
    expect(openHostingRequest({ zip_base64: atLimit, hinted_title: `  ${'t'.repeat(300)}  ` }, settings))
      .toEqual({ ok: true, zipBase64: atLimit, hintedTitle: 't'.repeat(200) });
    expect(openHostingRequest({ zip_base64: 'UEsDBA==' }, settings)).toEqual({ ok: true, zipBase64: 'UEsDBA==' });
    expect(openHostingRequest({ zip_base64: 'UEsDBA==', hinted_title: '   ' }, settings)).toEqual({ ok: true, zipBase64: 'UEsDBA==' });
  });

  it('refuses one character over, and says the size in the terms a person set it in', () => {
    const over = openHostingRequest({ zip_base64: 'A'.repeat(base64CharsFor(settings.maxZipBytes) + 1) }, settings);
    expect(over).toMatchObject({ ok: false, status: 413 });
    expect((over as { error: string }).error).toContain('1 MB');
  });

  it('refuses a payload with no package, or a title that is not text', () => {
    for (const payload of [{}, { zip_base64: '' }, { zip_base64: 7 }, { zip_base64: null }]) {
      expect(openHostingRequest(payload, settings)).toMatchObject({ ok: false, status: 400 });
    }
    expect(openHostingRequest({ zip_base64: 'UEsDBA==', hinted_title: 7 }, settings)).toMatchObject({ ok: false, status: 400 });
  });
});

describe('how many one signer may bring in an hour', () => {
  const HOUR = 3_600_000;
  it('admits up to the limit, then says when the next would be admitted', () => {
    const limit = new SignerHourlyLimit(2);
    expect(limit.admit('did:ethr:0xAA', 0)).toEqual({ ok: true });
    expect(limit.admit('did:ethr:0xAA', 60_000)).toEqual({ ok: true });
    expect(limit.admit('did:ethr:0xAA', 120_000)).toEqual({ ok: false, retryAfterSeconds: 3480 });
    // A refusal is not counted: the first admission still ages out on time.
    expect(limit.admit('did:ethr:0xAA', HOUR)).toEqual({ ok: true });
    expect(limit.admit('did:ethr:0xAA', HOUR + 1)).toMatchObject({ ok: false });
  });

  it('counts a signer the same however its address is cased, and each signer on its own', () => {
    const limit = new SignerHourlyLimit(1);
    expect(limit.admit('did:ethr:0xAbC', 0)).toEqual({ ok: true });
    expect(limit.admit('did:ethr:0xabc', 1)).toMatchObject({ ok: false });
    expect(limit.admit('did:ethr:0xdef', 1)).toEqual({ ok: true });
  });
});

describe('the route and what it advertises', () => {
  const server = read('../bridge/server.ts');
  const route = server.slice(server.indexOf("app.post('/agent/scorm/host'"), server.indexOf('// ── cmi5 for a signed learner'));

  it('is found by an agent as an affordance, routed to the signed route', () => {
    const a = foxxiAffordances.find(x => x.toolName === 'foxxi.host_package_signed');
    expect(a).toMatchObject({ method: 'POST', targetTemplate: '{base}/agent/scorm/host', externallyRouted: true });
    expect(a!.inputs.map(i => i.name)).toEqual(['_signed_payload', '_signature']);
  });

  it('checks the switch, the signature, the size and the signer before a byte is parsed', () => {
    const order = ['openHosting.enabled', 'verifyDelegatedCaller(req.body)', 'openHostingRequest(auth.payload, openHosting)', 'openHostingBySigner.admit(auth.callerDid)', 'uploadScormPackage({'].map(m => route.indexOf(m));
    expect(order.every(i => i > 0)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
  });

  it('names the signer as the uploader, never a name the payload offers, and hosts as the operator upload does', () => {
    expect(route).toContain('uploaderDid: auth.callerDid,');
    expect(route).not.toContain('auth.payload.uploader');
    expect(route).toContain('host: (bytes, parsed) => hostUploadedPackage(bytes, parsed.packageTitle, parsed.launchable),');
    expect(route).toContain('keepExport: (bytes, exported) => hostProjectExport(bytes, exported),');
  });

  it('answers a refused upload with its own status, not 200', () => {
    expect(route).toContain("const refused = result.kind === 'refusal' && typeof result['iep:refusalStatus'] === 'number' ? result['iep:refusalStatus'] : undefined;");
    expect(route).toContain('res.status(refused ?? 200)');
  });

  it('leaves the operator upload behind its directory role', () => {
    const operator = server.slice(server.indexOf("'foxxi.upload_scorm_package': async (args) => {"), server.indexOf("'foxxi.derive_adaptive_policy'"));
    expect(operator).toContain('if (!isAdminEquivalent(ctx.role)) return {');
  });
});

describe('taking a hosted package down', () => {
  const SHA = 'b'.repeat(64);
  /** A pod that keeps what is PUT and answers DELETE as `del` says. */
  const pod = (del: (url: string) => number) => {
    const kept = new Map<string, Uint8Array>();
    const calls: string[] = [];
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input), method = init?.method ?? 'GET';
      calls.push(`${method} ${url}`);
      if (method === 'PUT') { kept.set(url, new Uint8Array(await new Response(init?.body as BodyInit).arrayBuffer())); return new Response(null, { status: 201 }); }
      if (method === 'DELETE') { const status = del(url); if (status < 300) kept.delete(url); return new Response(null, { status }); }
      const body = kept.get(url);
      return body ? new Response(new Blob([new Uint8Array(body)]), { status: 200 }) : new Response(null, { status: 404 });
    }) as typeof fetch;
    return { kept, calls, fetchFn };
  };

  it('removes the package and what describes it from the pod, and nothing of it stays in hand', async () => {
    const { HostedPackages } = await import('../src/scorm-hosting.js');
    const AdmZip = (await import('adm-zip')).default;
    const zip = new AdmZip(); zip.addFile('index.html', Buffer.from('<p>hi</p>'));
    const bytes = zip.toBuffer();
    const p = pod(() => 204);
    const packages = new HostedPackages({ podUrl: 'https://pod.example/t/', fetch: p.fetchFn });
    const { sha256 } = await packages.keep(bytes, { title: 'T', launchable: ['index.html'] });
    expect(await packages.list()).toEqual([sha256]);
    expect(await packages.about(sha256)).toMatchObject({ title: 'T' });

    expect(await packages.remove(sha256)).toEqual({ removed: true });
    expect(p.kept.has(packages.urlOf(sha256))).toBe(false);
    expect(p.kept.has(packages.aboutUrlOf(sha256))).toBe(false);
    expect(await packages.open(sha256)).toBeNull();
    expect(await packages.about(sha256)).toBeNull();
    // Taking down what is already gone is not a failure.
    const gone = pod(() => 404);
    expect(await new HostedPackages({ podUrl: 'https://pod.example/t/', fetch: gone.fetchFn }).remove(SHA)).toEqual({ removed: true });
  });

  it('says so when the pod refuses, and still drops the package from memory', async () => {
    const { HostedPackages } = await import('../src/scorm-hosting.js');
    const AdmZip = (await import('adm-zip')).default;
    const zip = new AdmZip(); zip.addFile('index.html', Buffer.from('<p>hi</p>'));
    const p = pod(() => 403);
    const packages = new HostedPackages({ podUrl: 'https://pod.example/t/', fetch: p.fetchFn });
    const { sha256 } = await packages.keep(zip.toBuffer(), { title: 'T', launchable: ['index.html'] });
    expect(await packages.remove(sha256)).toEqual({ removed: false, why: 'the pod did not remove the package (HTTP 403)' });
    // Not in hand any more: the next read goes to the pod, which still keeps it.
    expect(p.calls.filter(c => c === `GET ${packages.urlOf(sha256)}`)).toHaveLength(0);
    expect(await packages.open(sha256)).not.toBeNull();
    expect(p.calls.filter(c => c === `GET ${packages.urlOf(sha256)}`)).toHaveLength(1);
  });

  it('refuses an id that is not a package id without asking the pod', async () => {
    const { HostedPackages } = await import('../src/scorm-hosting.js');
    const p = pod(() => 204);
    const packages = new HostedPackages({ podUrl: 'https://pod.example/t/', fetch: p.fetchFn });
    expect((await packages.remove('../auth-methods.jsonld')).removed).toBe(false);
    expect((await packages.remove('B'.repeat(64))).removed).toBe(false);
    expect(p.calls).toEqual([]);
  });

  it('is an admin\'s tool: role-gated, named by sha-256, and forgets the course', () => {
    const server = read('../bridge/server.ts');
    const handler = server.slice(server.indexOf("'foxxi.remove_hosted_package': async (args) => {"), server.indexOf("'foxxi.upload_scorm_package': async (args) => {"));
    const order = ['resolveCaller(args)', 'isAdminEquivalent(ctx.role)', 'PACKAGE_SHA.test(sha)', 'hostedPackages.remove(sha)'].map(m => handler.indexOf(m));
    expect(order.every(i => i > 0)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
    expect(handler).toContain('unregisterCmi5Course(DEFAULT_TENANT, `${bridgeBaseUrl}/scorm/packages/${sha}`)');
  });

  it('forgets a course, and says whether there was one', async () => {
    const { registerCmi5Course, getCmi5Course, unregisterCmi5Course } = await import('../src/cmi5-lms.js');
    const id = 'https://b.example/scorm/packages/' + SHA;
    registerCmi5Course('takedown-test', { id, title: 'T', structure: [] } as never);
    expect(getCmi5Course('takedown-test', id)).toBeDefined();
    expect(unregisterCmi5Course('takedown-test', id)).toBe(true);
    expect(getCmi5Course('takedown-test', id)).toBeUndefined();
    expect(unregisterCmi5Course('takedown-test', id)).toBe(false);
  });
});
