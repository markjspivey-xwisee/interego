/**
 * AN AUTHORING TOOL'S OWN EXPORT IS KEPT HERE TO BE FOLDED.
 *
 * An .h5p file, or an Adapt course exported as source, is no SCORM package: it has no manifest and
 * nothing to launch as it is. The upload refused it, so it could be neither hosted nor folded, though
 * the fold reads it in its tool's own model (tool-exports.ts). Now the upload reads it so, and the
 * bridge keeps it beside the packages it hosts, described as an export (scorm-hosting.ts): listed
 * apart from what plays, its record saying how to fold it, its files served in the same sandbox for
 * the pages folded from it. A SCORM package a tool built is hosted and played as one, as before.
 *
 * Here: what is an export and what is not, the upload's answer, the kept description, the listing,
 * the record and the files, the bridge's wiring, and the dashboard.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import AdmZip from 'adm-zip';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { uploadScormPackage } from '../src/composed-extensions.js';
import {
  HostedPackages, PACKAGE_SANDBOX, aboutFrom, attachHostedPackageRoutes, hostedPackageCourse, sha256Of, type PackageAbout,
} from '../src/scorm-hosting.js';
import { projectExportOf } from '../src/tool-exports.js';
import { foldablePackagesFrom, hostedPackagesFrom } from '../dashboard-app/src/learn/hosted-packages.js';

const BRIDGE = 'https://bridge.example';
const POD = 'https://pod.example/foxxi/';

const zipOf = (files: Record<string, string | object>): Buffer => {
  const zip = new AdmZip();
  for (const [name, body] of Object.entries(files)) zip.addFile(name, Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8'));
  return zip.toBuffer();
};
const H5P = zipOf({
  'h5p.json': { title: 'Plant cells', mainLibrary: 'H5P.Column' },
  'content/content.json': { content: [
    { content: { library: 'H5P.AdvancedText 1.1', params: { text: '<p>A cell has a wall.</p><img src="images/cell.png" alt="A cell">' } } },
    { content: { library: 'H5P.TrueFalse 1.8', params: { question: 'Plant cells have walls.', correct: 'true' } } },
  ] },
  'content/images/cell.png': 'png bytes',
  'H5P.TrueFalse-1.8/library.json': { machineName: 'H5P.TrueFalse' },
});
const adaptItems = (title: string): Record<string, object> => ({
  'course/en/course.json': { _id: 'course', _type: 'course', displayTitle: title },
  'course/en/contentObjects.json': [{ _id: 'p', _parentId: 'course', _type: 'page', displayTitle: 'Before' }],
  'course/en/articles.json': [{ _id: 'a', _parentId: 'p', _type: 'article' }],
  'course/en/blocks.json': [{ _id: 'b', _parentId: 'a', _type: 'block' }],
  'course/en/components.json': [{ _id: 'c', _parentId: 'b', _type: 'component', _component: 'text', body: '<p>Bend your knees.</p>' }],
});
/** An Adapt course exported as source: the framework's files, and the course under src/. */
const ADAPT_SOURCE = zipOf({
  'package.json': { name: 'adapt_framework' },
  ...Object.fromEntries(Object.entries(adaptItems('Lifting')).map(([k, v]) => [`src/${k}`, v])),
});
const MANIFEST = '<?xml version="1.0"?><manifest identifier="m" xmlns="http://www.imsglobal.org/xsd/imscp_v1p1" xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_v1p3"><organizations default="o"><organization identifier="o"><title>Lifting, built</title>'
  + '<item identifier="i" identifierref="r"><title>Lifting</title></item></organization></organizations><resources><resource identifier="r" type="webcontent" adlcp:scormType="sco" href="index.html"><file href="index.html"/></resource></resources></manifest>';
/** The same course built to be played: a SCORM package. */
const ADAPT_BUILD = zipOf({ 'imsmanifest.xml': MANIFEST, 'index.html': '<html><body><div id="wrapper"></div></body></html>', ...adaptItems('Lifting') });
const NEITHER = zipOf({ 'readme.txt': 'a zip, and nothing a tool here made' });

describe('what is an authoring tool\'s own export', () => {
  it('is an .h5p file or an Adapt course exported as source: no manifest, and read in its tool\'s model', () => {
    expect(projectExportOf(H5P)).toMatchObject({ tool: 'H5P', title: 'Plant cells' });
    expect(projectExportOf(ADAPT_SOURCE)).toMatchObject({ tool: 'Adapt', title: 'Lifting' });
    expect(projectExportOf(H5P)!.read.topics.map(t => [t.pages.length, t.questions.length])).toEqual([[1, 1]]);
  });

  it('is not a SCORM package a tool built, which is hosted and played as one, nor a zip no tool here made', () => {
    expect(projectExportOf(ADAPT_BUILD)).toBeNull();
    expect(projectExportOf(NEITHER)).toBeNull();
  });
});

describe('the upload reads an export and hands it to be kept, not played', () => {
  /** A pod that takes every write and holds nothing to read. */
  const anyPod = (async (_input: unknown, init?: { method?: string }) => new Response('', { status: (init?.method ?? 'GET').toUpperCase() === 'GET' ? 404 : 201 })) as never;

  it('reads it in its tool\'s model, promotes its receipt, and hands its own bytes to be kept', async () => {
    let seen: { bytes: Buffer; tool: string } | null = null;
    let played = false;
    const r = await uploadScormPackage({
      tenantPodUrl: POD, zipBase64: H5P.toString('base64'), hintedTitle: 'plant-cells', uploaderDid: 'did:web:admin.example', fetch: anyPod,
      host: async () => { played = true; return {}; },
      keepExport: async (bytes, exported) => { seen = { bytes, tool: exported.tool }; return { hosted: true, playable: false, packageSha256: sha256Of(bytes), status: 'overridden' }; },
    });
    expect(played).toBe(false);
    expect(seen!.bytes.equals(H5P)).toBe(true);
    expect(seen!.tool).toBe('H5P');
    // What the upload says of itself is not overridden by what the keeper says.
    expect(r).toMatchObject({
      status: 'parsed', packageTitle: 'Plant cells', hosted: true, playable: false, packageSha256: sha256Of(H5P),
      exported: { tool: 'H5P', packageTitle: 'Plant cells', topics: 1, pages: 1, questions: 1, unread: 0 },
    });
    expect(r.parsed).toBeUndefined();
    expect(r.parsedDescriptorUrl).toMatch(/-parsed/);
    expect(r.note).toMatch(/kept to be folded/);
  });

  it('reads an Adapt course exported as source too, titled by its course', async () => {
    const r = await uploadScormPackage({ tenantPodUrl: POD, zipBase64: ADAPT_SOURCE.toString('base64'), uploaderDid: 'did:web:admin.example', fetch: anyPod });
    expect(r).toMatchObject({ status: 'parsed', packageTitle: 'Lifting', exported: { tool: 'Adapt', topics: 1, pages: 1, questions: 0 } });
  });

  it('still refuses a zip that is neither a package nor a tool\'s export, and says what it looked for', async () => {
    let called = false;
    const r = await uploadScormPackage({
      tenantPodUrl: POD, zipBase64: NEITHER.toString('base64'), uploaderDid: 'did:web:admin.example', fetch: anyPod,
      host: async () => { called = true; return {}; }, keepExport: async () => { called = true; return {}; },
    });
    expect(called).toBe(false);
    expect(r).toMatchObject({ status: 'failed', kind: 'refusal', 'iep:refusalStatus': 422 });
    expect(r.error).toMatch(/missing imsmanifest\.xml or cmi5\.xml/);
    expect(r.error).toMatch(/nor is it an authoring tool's own export read here \(an Adapt course, H5P content\)/);
  });

  it('hosts a SCORM package a tool built as a package, to be played', async () => {
    const reached: string[] = [];
    const r = await uploadScormPackage({
      tenantPodUrl: POD, zipBase64: ADAPT_BUILD.toString('base64'), uploaderDid: 'did:web:admin.example', fetch: anyPod,
      host: async () => { reached.push('host'); return { hosted: true }; }, keepExport: async () => { reached.push('keepExport'); return {}; },
    });
    expect(reached).toEqual(['host']);
    expect(r.parsed?.launchable).toEqual(['index.html']);
    expect(r.exported).toBeUndefined();
  });
});

/** A stand-in pod: a map of resources, and a record of what was asked of it. */
function standInPod() {
  const kept = new Map<string, Buffer>();
  const asked: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    asked.push(`${init?.method ?? 'GET'} ${url}`);
    if (init?.method === 'PUT') { kept.set(url, Buffer.from(await new Response(init.body as BodyInit).arrayBuffer())); return new Response(null, { status: 201 }); }
    if (url.endsWith('/')) {
      const members = [...kept.keys()].filter(k => k.startsWith(url) && k !== url).map(k => `<${k.slice(url.length)}>`);
      return new Response(`<> a <http://www.w3.org/ns/ldp#BasicContainer>${members.length ? `; <http://www.w3.org/ns/ldp#contains> ${members.join(', ')}` : ''} .`, { status: 200, headers: { 'Content-Type': 'text/turtle' } });
    }
    const bytes = kept.get(url);
    return bytes ? new Response(new Uint8Array(bytes), { status: 200 }) : new Response('', { status: 404 });
  }) as typeof fetch;
  return { kept, asked, fetchImpl };
}

/** What a kept package's bytes say it is, as the bridge describes one: an export as an export. */
function describePackage(bytes: Buffer): PackageAbout | null {
  const exported = projectExportOf(bytes);
  return exported ? { title: exported.title, launchable: [], exportOf: exported.tool } : { title: 'Lifting, built', launchable: ['index.html'] };
}

describe('an export kept beside the packages hosted here', () => {
  const SHA = sha256Of(H5P);
  const BUILT = sha256Of(ADAPT_BUILD);
  const ABOUT: PackageAbout = { title: 'Plant cells', launchable: [], exportOf: 'H5P' };
  const BUILT_ABOUT: PackageAbout = { title: 'Lifting, built', launchable: ['index.html'] };
  const pod = standInPod();
  let server: Server;
  let base = '';
  beforeAll(async () => {
    const packages = new HostedPackages({ podUrl: POD, fetch: pod.fetchImpl, describePackage });
    await packages.keep(H5P, ABOUT);
    await packages.keep(ADAPT_BUILD, BUILT_ABOUT);
    const app = express();
    attachHostedPackageRoutes(app, {
      packages, bridgeBaseUrl: BRIDGE,
      courseFor: async sha => (sha === BUILT ? hostedPackageCourse(BRIDGE, sha, BUILT_ABOUT) : undefined),
      onError: (res, err) => { res.status(500).json({ error: String(err) }); },
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>(r => server.once('listening', () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => { await new Promise<void>(r => server.close(() => r())); });

  it('is described as an export beside it: its title and its tool, with nothing to launch', async () => {
    expect(JSON.parse(pod.kept.get(`${POD}foxxi-uploads/packages/${SHA}.json`)!.toString('utf8'))).toEqual({ packageSha256: SHA, title: 'Plant cells', launchable: [], exportOf: 'H5P' });
    expect(await new HostedPackages({ podUrl: POD, fetch: pod.fetchImpl }).about(SHA)).toEqual(ABOUT);
    // An export launches nothing, whatever a description beside it says; one with no tool is no export.
    expect(aboutFrom(SHA, { packageSha256: SHA, title: 'x', launchable: ['index.html'], exportOf: 'H5P' })).toEqual({ title: 'x', launchable: [], exportOf: 'H5P' });
    expect(aboutFrom(SHA, { packageSha256: SHA, title: 'x', launchable: [], exportOf: ' ' })).toBeNull();
    expect(aboutFrom(SHA, { packageSha256: SHA, title: 'x', launchable: [], exportOf: 7 })).toBeNull();
  });

  it('is described so from itself when nothing beside it says, and that is kept', async () => {
    const bare = standInPod();
    await new HostedPackages({ podUrl: POD, fetch: bare.fetchImpl }).keep(H5P);
    const later = new HostedPackages({ podUrl: POD, fetch: bare.fetchImpl, describePackage });
    expect(await later.aboutNow(SHA)).toEqual(ABOUT);
    expect(JSON.parse(bare.kept.get(`${POD}foxxi-uploads/packages/${SHA}.json`)!.toString('utf8'))).toMatchObject({ exportOf: 'H5P' });
  });

  it('is listed apart from what plays, with the fold that takes it', async () => {
    const listing = await (await fetch(`${base}/scorm/packages`)).json() as { packages: Array<{ course: { title: string } }>; exports: unknown[]; fold: unknown; unlisted?: number };
    expect(listing.packages.map(p => p.course.title)).toEqual(['Lifting, built']);
    expect(listing.exports).toEqual([{ packageSha256: SHA, href: `${BRIDGE}/scorm/packages/${SHA}`, title: 'Plant cells', exportOf: 'H5P' }]);
    expect(listing.fold).toMatchObject({ toolName: 'foxxi.content_fold_course', method: 'POST', target: `${BRIDGE}/agent/content/fold-course` });
    expect(listing.unlisted).toBeUndefined();
  });

  it('has a record that says it is folded, not played', async () => {
    const record = await (await fetch(`${base}/scorm/packages/${SHA}`)).json();
    expect(record).toMatchObject({
      kind: 'hosted-project-export', packageSha256: SHA, title: 'Plant cells', exportOf: 'H5P',
      fold: { toolName: 'foxxi.content_fold_course', method: 'POST', target: `${BRIDGE}/agent/content/fold-course`, payload: { package_sha256: SHA } },
    });
    expect((await fetch(`${base}/scorm/packages/${'1'.repeat(64)}`)).status).toBe(404);
  });

  it('serves its files in the same sandbox, for the pages folded from it', async () => {
    const r = await fetch(`${base}/scorm/packages/${SHA}/files/content/images/cell.png`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-security-policy')).toBe(PACKAGE_SANDBOX);
    expect(Buffer.from(await r.arrayBuffer()).toString('utf8')).toBe('png bytes');
  });
});

describe('the bridge keeps an upload that is an export, and folds it as any hosted package', () => {
  const server = readFileSync(new URL('../bridge/server.ts', import.meta.url), 'utf8');

  it('hands the upload a way to keep an export, beside the way to host a package', () => {
    const upload = server.slice(server.indexOf("'foxxi.upload_scorm_package': async (args) => {"), server.indexOf("'foxxi.derive_adaptive_policy': async (args) => {"));
    expect(upload).toContain('      host: (bytes, parsed) => hostUploadedPackage(bytes, parsed.packageTitle, parsed.launchable),\n      keepExport: (bytes, exported) => hostProjectExport(bytes, exported),\n    });');
  });

  it('keeps an export described as one, and says how to fold it', () => {
    const keep = server.slice(server.indexOf('async function hostProjectExport('), server.indexOf('async function restoreHostedPackage('));
    expect(keep).toContain('const about: PackageAbout = { title: exported.packageTitle, launchable: [], exportOf: exported.tool };');
    expect(keep).toContain('try { kept = await hostedPackages.keep(bytes, about); }');
    expect(keep).toContain('payload: { package_sha256: kept.sha256 }');
  });

  it('describes a kept export as one, and makes no course of it', () => {
    const describeFn = server.slice(server.indexOf('function describeHostedPackage('), server.indexOf('async function hostUploadedPackage('));
    expect(describeFn).toContain('const exported = projectExportOf(bytes);');
    expect(describeFn).toContain('if (exported) return { title: exported.title, launchable: [], exportOf: exported.tool };');
    const restore = server.slice(server.indexOf('async function restoreHostedPackage('), server.indexOf('attachHostedPackageRoutes(app, {'));
    expect(restore).toContain('if (about?.launchable.length) registerCmi5Course(DEFAULT_TENANT, hostedPackageCourse(bridgeBaseUrl, sha, about));');
  });
});

describe('the dashboard hosts an export and folds it', () => {
  const listing = {
    packages: [{ packageSha256: 'a'.repeat(64), href: `${BRIDGE}/scorm/packages/${'a'.repeat(64)}`, course: { id: `${BRIDGE}/scorm/packages/${'a'.repeat(64)}`, title: 'Lifting, built' }, aus: [] }],
    exports: [
      { packageSha256: 'b'.repeat(64), href: `${BRIDGE}/scorm/packages/${'b'.repeat(64)}`, title: 'Plant cells', exportOf: 'H5P' },
      { packageSha256: 'not a sha', href: BRIDGE, title: 'x', exportOf: 'H5P' },
      { packageSha256: 'c'.repeat(64), href: `${BRIDGE}/scorm/packages/${'c'.repeat(64)}`, title: 'No tool' },
      null,
    ],
  };

  it('folds every package the listing names, those that play and the exports kept to be folded; the Learn page plays only the first', () => {
    expect(foldablePackagesFrom(listing)).toEqual([
      { packageSha256: 'a'.repeat(64), title: 'Lifting, built' },
      { packageSha256: 'b'.repeat(64), title: 'Plant cells', exportOf: 'H5P' },
    ]);
    expect(hostedPackagesFrom(listing).map(p => p.course.title)).toEqual(['Lifting, built']);
  });

  it('takes an .h5p file to host, and says an export is kept to be folded, on the Author page', () => {
    const panel = readFileSync(new URL('../dashboard-app/src/components/LmsContentPanel.tsx', import.meta.url), 'utf8');
    expect(panel).toContain('accept=".zip,.h5p,application/zip"');
    expect(panel).toContain("hinted_title: file.name.replace(/\\.(?:zip|h5p)$/i, '')");
    expect(panel).toContain('{result?.hosted === true && result.playable === false && (');
    const card = readFileSync(new URL('../dashboard-app/src/components/FoldPackageCard.tsx', import.meta.url), 'utf8');
    expect(card).toContain('.then(body => { if (!cancel) setPackages(foldablePackagesFrom(body)); })');
    expect(card).toContain('{p.exportOf && <Pill tone="neutral">{p.exportOf} export</Pill>}');
  });
});
