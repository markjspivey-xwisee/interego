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
