/**
 * An uploaded SCORM package is hosted by the bridge itself, each of its documents in a sandbox of
 * its own, and played as a cmi5 course through the LMS the bridge already runs.
 *
 * ★ WHY. Uploading a package kept a record of it (title, SCOs, authoring tool) and not the package:
 * nothing could be played. Hosting someone else's HTML and script on the bridge's origin as it is
 * would hand it that origin. A response sent with `Content-Security-Policy: sandbox` (and no
 * `allow-same-origin`) runs in an opaque origin instead, so no second origin is needed. Content
 * there cannot reach an LMS in a parent window, so the runtime goes into each document, after a
 * bootstrap that stands in for web storage and takes the cmi5 launch's own token (src/scorm-hosting.ts).
 *
 * Here: the pure pieces, the package store against a stand-in pod, the routes over HTTP, the
 * bootstrap and the runtime together in a page that cannot use storage (as a sandboxed one
 * cannot), and the bridge's wiring.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import { JSDOM } from 'jsdom';
import {
  HostedPackages, PACKAGE_SANDBOX, SANDBOX_BOOTSTRAP, aboutFrom, attachHostedPackageRoutes, contentTypeOf, hostedPackageCourse,
  hostedPackageOf, isHtmlDocument, packageEntry, scormRuntimeSource, sha256Of, withRuntime, type PackageAbout,
} from '../src/scorm-hosting.js';
import { unwrapScormPackage } from '../../_shared/scorm/index.js';
import { uploadScormPackage } from '../src/composed-extensions.js';

const BRIDGE = 'https://bridge.example';
const POD = 'https://pod.example/foxxi/';
const MANIFEST = '<?xml version="1.0"?><manifest identifier="pkg" xmlns="http://www.imsglobal.org/xsd/imscp_v1p1" xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_v1p3">'
  + '<organizations default="o"><organization identifier="o"><title>Refunds, hosted</title><item identifier="i1" identifierref="r1"><title>Refunds</title></item></organization></organizations>'
  + '<resources><resource identifier="r1" type="webcontent" adlcp:scormType="sco" href="index.html"><file href="index.html"/></resource></resources></manifest>';
const PAGE = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Refunds</title><script src="app.js"></script></head><body><h1>Refunds</h1></body></html>';
/** A page in another encoding: its bytes must go out as they came in. */
const LATIN1_PAGE = Buffer.concat([Buffer.from('<html><head><meta charset="windows-1252"></head><body>caf', 'latin1'), Buffer.from([0xe9]), Buffer.from('</body></html>', 'latin1')]);

const XHTML_PAGE = '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head><body><p>x</p></body></html>';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function makePackage(): Buffer {
  const zip = new AdmZip();
  zip.addFile('imsmanifest.xml', Buffer.from(MANIFEST, 'utf8'));
  zip.addFile('index.html', Buffer.from(PAGE, 'utf8'));
  zip.addFile('app.js', Buffer.from('window.appLoaded = true;', 'utf8'));
  zip.addFile('media/Diagram.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'utf8'));
  zip.addFile('old.htm', LATIN1_PAGE);
  zip.addFile('media/big picture.png', PNG);
  zip.addFile('page.xhtml', Buffer.from(XHTML_PAGE, 'utf8'));
  return zip.toBuffer();
}
const PACKAGE = makePackage();
const SHA = sha256Of(PACKAGE);
const ABOUT: PackageAbout = { title: 'Refunds, hosted', launchable: ['index.html'] };

/** The same package titled otherwise: another package, with another sha-256. */
function makeRetitled(title: string): Buffer {
  const zip = new AdmZip(PACKAGE);
  zip.updateFile('imsmanifest.xml', Buffer.from(MANIFEST.replace('Refunds, hosted', title), 'utf8'));
  return zip.toBuffer();
}

/** What a package's bytes say it is, as the bridge describes one (bridge/server.ts). */
function describePackage(bytes: Buffer): PackageAbout | null {
  const pkg = unwrapScormPackage(bytes);
  const launchable = pkg.resources.filter(r => r.isLaunchable).map(r => r.path);
  return launchable.length ? { title: pkg.title, launchable } : null;
}

/** How many times a package's zip was read from the stand-in pod. */
const zipReads = (asked: readonly string[], sha = SHA): number => asked.filter(a => a === `GET ${POD}foxxi-uploads/packages/${sha}.zip`).length;

/** A stand-in pod: a map of resources, and a record of what was asked of it. */
function standInPod() {
  const kept = new Map<string, Buffer>();
  const asked: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const link = new Headers(init?.headers).get('Link');
    asked.push(`${init?.method ?? 'GET'} ${url}${link ? ` ${link}` : ''}`);
    if (init?.method === 'PUT') { kept.set(url, Buffer.from(await new Response(init.body as BodyInit).arrayBuffer())); return new Response(null, { status: 201 }); }
    // A container answers with what it contains, as an LDP container does.
    if (url.endsWith('/')) {
      const members = [...kept.keys()].filter(k => k.startsWith(url) && k !== url).map(k => `<${k.slice(url.length)}>`);
      return new Response(`<> a <http://www.w3.org/ns/ldp#BasicContainer>${members.length ? `; <http://www.w3.org/ns/ldp#contains> ${members.join(', ')}` : ''} .`, { status: 200, headers: { 'Content-Type': 'text/turtle' } });
    }
    const bytes = kept.get(url);
    return bytes ? new Response(new Uint8Array(bytes), { status: 200 }) : new Response('', { status: 404 });
  }) as typeof fetch;
  return { kept, asked, fetchImpl };
}

describe('the sandbox and the files a package serves', () => {
  it('runs scripts, forms and popups, in an origin of its own, and may not reach the top window', () => {
    const tokens = PACKAGE_SANDBOX.split(' ');
    expect(tokens[0]).toBe('sandbox');
    expect(tokens).toContain('allow-scripts');
    for (const never of ['allow-same-origin', 'allow-top-navigation', 'allow-top-navigation-by-user-activation', 'allow-popups-to-escape-sandbox']) {
      expect(tokens).not.toContain(never);
    }
  });

  it('serves a path only inside the package: no dot segments, empty segments, backslashes or absolute paths', () => {
    const zip = new AdmZip(PACKAGE);
    expect(packageEntry(zip, 'index.html')?.entryName).toBe('index.html');
    expect(packageEntry(zip, 'media/diagram.svg')?.entryName).toBe('media/Diagram.svg');
    for (const bad of ['../index.html', 'media/../index.html', './index.html', '/index.html', 'media//Diagram.svg', 'media\\Diagram.svg', 'index.html\0', '', 'missing.html']) {
      expect(packageEntry(zip, bad), bad).toBeNull();
    }
    const twins = new AdmZip();
    twins.addFile('A.html', Buffer.from('a'));
    twins.addFile('a.HTML', Buffer.from('b'));
    expect(packageEntry(twins, 'a.html')).toBeNull();
    // A zip may itself carry such names (a writer cleans them, a crafted archive need not), and
    // an entry of that name is still refused by name.
    const forged = new AdmZip(renamed(renamed(makeWith(['zz/evil.html', 'win_page.html']), 'zz/evil.html', '../evil.html'), 'win_page.html', 'win\\page.html'));
    expect(forged.getEntries().map(e => e.entryName).sort()).toEqual(['../evil.html', 'win\\page.html']);
    expect(packageEntry(forged, '../evil.html')).toBeNull();
    expect(packageEntry(forged, 'win\\page.html')).toBeNull();
  });

  it('names each file\'s type, and knows a document from anything else', () => {
    expect(contentTypeOf('x/index.HTML')).toBe('text/html');
    expect(contentTypeOf('app.js')).toBe('text/javascript');
    expect(contentTypeOf('a.svg')).toBe('image/svg+xml');
    expect(contentTypeOf('archive.bin')).toBe('application/octet-stream');
    expect(isHtmlDocument('old.htm') && isHtmlDocument('page.xhtml') && !isHtmlDocument('a.svg')).toBe(true);
  });

  it('puts the runtime first in a document\'s head, and every other byte goes out as it came in', () => {
    const runtime = `${BRIDGE}/scorm/runtime/scorm-rte.js`;
    const out = withRuntime(Buffer.from(PAGE, 'utf8'), runtime).toString('utf8');
    const tags = `<script>${SANDBOX_BOOTSTRAP}</script><script src="${runtime}"></script>`;
    expect(out).toBe(PAGE.replace('<head>', `<head>${tags}`));
    expect(out.indexOf(tags)).toBeLessThan(out.indexOf('<script src="app.js">'));
    const latin = withRuntime(LATIN1_PAGE, runtime);
    expect(latin.includes(Buffer.from([0x63, 0x61, 0x66, 0xe9]))).toBe(true);
    expect(latin.length).toBe(LATIN1_PAGE.length + Buffer.byteLength(tags, 'latin1'));
    expect(withRuntime(Buffer.from('<p>no head</p>'), runtime).toString().startsWith(tags)).toBe(true);
    expect(withRuntime(Buffer.from('<html data-x="1"><p>x</p></html>'), runtime).toString()).toBe(`<html data-x="1">${tags}<p>x</p></html>`);
    expect(withRuntime(Buffer.from('<p/>'), 'https://b.example/x"y').toString()).toContain('src="https://b.example/x&quot;y"');
  });

  it('bootstraps with nothing that could end its script or change as it is sent', () => {
    for (const unsafe of ['\\', '`', '${', '</script', '<!--', ']]>']) expect(SANDBOX_BOOTSTRAP.includes(unsafe), unsafe).toBe(false);
  });

  it('keeps an XHTML document well-formed XML, the bootstrap in a CDATA section', () => {
    // Codex, on #548: served as application/xhtml+xml, a document is parsed as XML, and the
    // bootstrap's bare `<` and `&&` stopped the parser before any script ran.
    const xhtml = '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head><body><p>x</p></body></html>';
    const { DOMParser } = new JSDOM('').window;
    const parse = (s: string) => new DOMParser().parseFromString(s, 'application/xhtml+xml');
    const out = withRuntime(Buffer.from(xhtml), `${BRIDGE}/scorm/runtime/scorm-rte.js`, { xml: true }).toString('utf8');
    expect(out.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    const doc = parse(out);
    expect(doc.getElementsByTagName('parsererror')).toHaveLength(0);
    expect(doc.getElementsByTagName('script')[0]!.textContent).toBe(SANDBOX_BOOTSTRAP);
    // Put in bare, the same bootstrap is not XML: the reason for the CDATA.
    expect(parse(withRuntime(Buffer.from(xhtml), `${BRIDGE}/scorm/runtime/scorm-rte.js`).toString('utf8')).getElementsByTagName('parsererror').length).toBeGreaterThan(0);
  });
});

describe('a package is a cmi5 course of its SCOs, and is kept by what it is', () => {
  it('has one AU per launchable SCO, launched from its file here, moving on when it completes or passes', () => {
    const pkg = unwrapScormPackage(PACKAGE);
    const launchable = pkg.resources.filter(r => r.isLaunchable).map(r => r.path);
    expect(launchable).toEqual(['index.html']);
    const course = hostedPackageCourse(`${BRIDGE}/`, SHA, { title: pkg.title, launchable: [...launchable, 'part two/start.html'] });
    expect(course.id).toBe(`${BRIDGE}/scorm/packages/${SHA}`);
    expect(course.structure).toEqual([
      { kind: 'au', id: `${course.id}/au/0`, title: `${pkg.title} (1 of 2)`, url: `${course.id}/files/index.html`, moveOn: 'CompletedOrPassed', launchMethod: 'AnyWindow' },
      { kind: 'au', id: `${course.id}/au/1`, title: `${pkg.title} (2 of 2)`, url: `${course.id}/files/part%20two/start.html`, moveOn: 'CompletedOrPassed', launchMethod: 'AnyWindow' },
    ]);
    expect(hostedPackageOf(BRIDGE, course.id)).toBe(SHA);
    expect(hostedPackageOf(BRIDGE, `${course.id}/au/0`)).toBeNull();
    expect(hostedPackageOf(BRIDGE, 'refund-course')).toBeNull();
  });

  it('makes no AU of a SCO whose path would leave the package: its launch URL, resolved, would be another of the bridge\'s routes', () => {
    const course = hostedPackageCourse(BRIDGE, SHA, { title: 'x', launchable: ['../../../agent/cmi5/launch', 'sco/../../../x.html', '/abs.html', 'a//b.html', 'a\\b.html', './index.html', 'index.html'] });
    expect(course.structure.map(a => (a.kind === 'au' ? a.url : a.kind))).toEqual([`${BRIDGE}/scorm/packages/${SHA}/files/index.html`]);
    expect(course.structure[0]!.title).toBe('x');
  });

  it('is kept on the pod under its sha-256, and read back only when its bytes still hash to it', async () => {
    const pod = standInPod();
    const kept = await new HostedPackages({ podUrl: POD, fetch: pod.fetchImpl }).keep(PACKAGE);
    expect(kept).toEqual({ sha256: SHA, url: `${POD}foxxi-uploads/packages/${SHA}.zip` });
    // The container is made first: a fresh tenant pod has none, and a Solid store does not always
    // make a PUT's parent (Codex, on #548).
    expect(pod.asked.slice(0, 2)).toEqual([
      `PUT ${POD}foxxi-uploads/packages/ <http://www.w3.org/ns/ldp#BasicContainer>; rel="type"`,
      `PUT ${POD}foxxi-uploads/packages/${SHA}.zip`,
    ]);
    expect(pod.kept.get(kept.url)!.equals(PACKAGE)).toBe(true);
    // A process that did not keep it reads it from the pod.
    const later = new HostedPackages({ podUrl: POD, fetch: pod.fetchImpl });
    expect((await later.open(SHA))!.getEntry('index.html')!.getData().toString()).toBe(PAGE);
    // Bytes that are not the package this id names are not it.
    pod.kept.set(kept.url, makeTampered());
    expect(await new HostedPackages({ podUrl: POD, fetch: pod.fetchImpl }).open(SHA)).toBeNull();
    // An id that is not a sha-256 is not looked for at all.
    const before = pod.asked.length;
    expect(await later.open('../../etc/passwd')).toBeNull();
    expect(pod.asked.length).toBe(before);
  });
});

/** A zip of the named one-byte files. */
function makeWith(names: string[]): Buffer {
  const zip = new AdmZip();
  for (const n of names) zip.addFile(n, Buffer.from('x'));
  return zip.toBuffer();
}
/** The same zip with an entry's name rewritten, byte for byte, where a writer would have cleaned it. */
function renamed(zip: Buffer, from: string, to: string): Buffer {
  const f = Buffer.from(from, 'latin1');
  const t = Buffer.from(to, 'latin1');
  if (f.length !== t.length) throw new Error('a name is rewritten in place, so only to one of the same length');
  const out = Buffer.from(zip);
  for (let i = out.indexOf(f); i !== -1; i = out.indexOf(f, i + t.length)) t.copy(out, i);
  return out;
}

describe('the packages kept here are listed', () => {
  it('from the pod\'s package container, with any held in memory, and from memory alone when the pod does not answer', async () => {
    const pod = standInPod();
    const first = new HostedPackages({ podUrl: POD, fetch: pod.fetchImpl });
    await first.keep(PACKAGE);
    const other = makeWith(['imsmanifest.xml']);
    await first.keep(other);
    // Another process, holding nothing, lists both from the pod.
    expect((await new HostedPackages({ podUrl: POD, fetch: pod.fetchImpl }).list()).sort()).toEqual([SHA, sha256Of(other)].sort());
    // A pod that stops answering leaves what this process holds.
    let up = true;
    const flaky = (async (input: string | URL | Request, init?: RequestInit) => {
      if (!up) throw new Error('the pod did not answer');
      return pod.fetchImpl(input, init);
    }) as typeof fetch;
    const holder = new HostedPackages({ podUrl: POD, fetch: flaky });
    await holder.keep(PACKAGE);
    up = false;
    expect(await holder.list()).toEqual([SHA]);
    expect(await first.list(1)).toHaveLength(1);
  });
});

describe('what a package is, kept beside it, so a listing opens none (Codex, on #550)', () => {
  it('is kept beside the package, and read back by another process without opening the package', async () => {
    const pod = standInPod();
    await new HostedPackages({ podUrl: POD, fetch: pod.fetchImpl }).keep(PACKAGE, ABOUT);
    expect(JSON.parse(pod.kept.get(`${POD}foxxi-uploads/packages/${SHA}.json`)!.toString('utf8'))).toEqual({ packageSha256: SHA, ...ABOUT });
    const later = new HostedPackages({ podUrl: POD, fetch: pod.fetchImpl });
    expect(await later.about(SHA)).toEqual(ABOUT);
    expect(zipReads(pod.asked)).toBe(0);
    // A description is not a package: it is not listed as one.
    expect(await later.list()).toEqual([SHA]);
    // What is kept names only paths inside the package, and nothing at all when none are.
    await later.keepAbout(SHA, { title: 'Refunds', launchable: ['../../agent/x.html', 'index.html'] });
    expect(JSON.parse(pod.kept.get(`${POD}foxxi-uploads/packages/${SHA}.json`)!.toString('utf8')).launchable).toEqual(['index.html']);
    await later.keepAbout(SHA, { title: 'Nothing', launchable: ['../x.html'] });
    expect(await later.about(SHA)).toEqual({ title: 'Refunds', launchable: ['index.html'] });
  });

  it('takes a description only of the package it is kept beside, naming only paths inside it', () => {
    expect(aboutFrom(SHA, { packageSha256: SHA, ...ABOUT })).toEqual(ABOUT);
    expect(aboutFrom(SHA, { packageSha256: 'b'.repeat(64), ...ABOUT })).toBeNull();
    expect(aboutFrom(SHA, { packageSha256: SHA, title: 'x', launchable: ['../../agent/cmi5/launch', '/etc/x.html', 'a//b.html', 'a\\b.html', 7] })).toBeNull();
    expect(aboutFrom(SHA, { packageSha256: SHA, title: 'x', launchable: ['../x.html', 'sco/one.html'] })).toEqual({ title: 'x', launchable: ['sco/one.html'] });
    expect(aboutFrom(SHA, { packageSha256: SHA, launchable: ['index.html'] })).toBeNull();
    expect(aboutFrom(SHA, null)).toBeNull();
  });

  it('reads a package from the pod once, however many ask for it at once', async () => {
    const pod = standInPod();
    await new HostedPackages({ podUrl: POD, fetch: pod.fetchImpl }).keep(PACKAGE);
    const later = new HostedPackages({ podUrl: POD, fetch: pod.fetchImpl });
    const zips = await Promise.all([later.open(SHA), later.open(SHA), later.open(SHA)]);
    expect(zips[0]).not.toBeNull();
    expect(zips.every(z => z === zips[0])).toBe(true);
    expect(zipReads(pod.asked)).toBe(1);
  });

  it('describes packages kept with nothing beside them in the background, one at a time and each once, and keeps what it found', async () => {
    const pod = standInPod();
    const first = new HostedPackages({ podUrl: POD, fetch: pod.fetchImpl });
    const other = makeRetitled('Returns, hosted');
    await first.keep(PACKAGE);
    await first.keep(other);
    let reading = 0;
    let most = 0;
    const slow = (async (input: string | URL | Request, init?: RequestInit) => {
      const zip = String(input).endsWith('.zip') && (init?.method ?? 'GET') === 'GET';
      if (zip) { reading++; most = Math.max(most, reading); await new Promise(r => setTimeout(r, 5)); }
      try { return await pod.fetchImpl(input, init); } finally { if (zip) reading--; }
    }) as typeof fetch;
    const later = new HostedPackages({ podUrl: POD, fetch: slow, describePackage });
    // Nothing describes them yet: null now, and each queued once, however often asked, whether it
    // is being read (the first) or waiting its turn (the second).
    const asked = [SHA, SHA, sha256Of(other), sha256Of(other)];
    expect(await Promise.all(asked.map(sha => later.aboutOrLater(sha)))).toEqual([null, null, null, null]);
    expect(later.waiting).toBe(1);
    await later.whenDescribed();
    expect(most).toBe(1);
    expect(zipReads(pod.asked)).toBe(1);
    expect(zipReads(pod.asked, sha256Of(other))).toBe(1);
    expect(await later.aboutOrLater(SHA)).toEqual(ABOUT);
    expect(await later.aboutOrLater(sha256Of(other))).toEqual({ title: 'Returns, hosted', launchable: ['index.html'] });
    // What it found is kept beside each package: another process reads that, and opens neither.
    const third = new HostedPackages({ podUrl: POD, fetch: pod.fetchImpl, describePackage });
    expect(await third.aboutOrLater(SHA)).toEqual(ABOUT);
    await third.whenDescribed();
    expect(zipReads(pod.asked)).toBe(1);
  });

  it('leaves a package it could not describe until it may try again, rather than opening it once a listing', async () => {
    const pod = standInPod();
    const notAPackage = makeWith(['notes.txt']);
    const sha = sha256Of(notAPackage);
    await new HostedPackages({ podUrl: POD, fetch: pod.fetchImpl }).keep(notAPackage);
    const later = new HostedPackages({ podUrl: POD, fetch: pod.fetchImpl, describePackage });
    for (let i = 0; i < 3; i++) { expect(await later.aboutOrLater(sha)).toBeNull(); await later.whenDescribed(); }
    expect(zipReads(pod.asked, sha)).toBe(1);
    // Once it may be tried again, it is.
    const eager = new HostedPackages({ podUrl: POD, fetch: pod.fetchImpl, describePackage, retryAfterMs: 0 });
    for (let i = 0; i < 2; i++) { expect(await eager.aboutOrLater(sha)).toBeNull(); await eager.whenDescribed(); }
    expect(zipReads(pod.asked, sha)).toBe(3);
  });

  it('does not read again a package a launch described while it waited its turn (Codex, on #551)', async () => {
    const pod = standInPod();
    const first = new HostedPackages({ podUrl: POD, fetch: pod.fetchImpl });
    const slowOne = makeRetitled('Slow to read');
    await first.keep(slowOne);
    await first.keep(PACKAGE);
    // The first package takes long to read; the second little.
    const paced = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if ((init?.method ?? 'GET') === 'GET' && url.endsWith('.zip')) await new Promise(r => setTimeout(r, url.includes(sha256Of(slowOne)) ? 60 : 5));
      return pod.fetchImpl(input, init);
    }) as typeof fetch;
    const later = new HostedPackages({ podUrl: POD, fetch: paced, describePackage });
    // A listing queues both: the slow one is being read, and this one waits behind it.
    await Promise.all([later.aboutOrLater(sha256Of(slowOne)), later.aboutOrLater(SHA)]);
    expect(later.waiting).toBe(1);
    // A launch describes the waiting one now, and the background, reaching it, reads nothing more.
    expect(await later.aboutNow(SHA)).toEqual(ABOUT);
    await later.whenDescribed();
    expect(zipReads(pod.asked)).toBe(1);
    expect(zipReads(pod.asked, sha256Of(slowOne))).toBe(1);
  });

  it('describes a package now for someone about to play it, and keeps that for the listing', async () => {
    const pod = standInPod();
    await new HostedPackages({ podUrl: POD, fetch: pod.fetchImpl }).keep(PACKAGE);
    const later = new HostedPackages({ podUrl: POD, fetch: pod.fetchImpl, describePackage });
    expect(await later.aboutNow(SHA)).toEqual(ABOUT);
    expect(zipReads(pod.asked)).toBe(1);
    expect(JSON.parse(pod.kept.get(`${POD}foxxi-uploads/packages/${SHA}.json`)!.toString('utf8'))).toEqual({ packageSha256: SHA, ...ABOUT });
    // Without a way to describe one, nothing is made up.
    expect(await new HostedPackages({ podUrl: POD, fetch: pod.fetchImpl }).aboutNow(sha256Of(makeRetitled('Unkept')))).toBeNull();
  });
});

function makeTampered(): Buffer {
  const zip = new AdmZip(PACKAGE);
  zip.updateFile('app.js', Buffer.from('steal()', 'utf8'));
  return zip.toBuffer();
}

describe('the routes a hosted package is reached by', () => {
  let server: Server;
  let base = '';
  beforeAll(async () => {
    const pod = standInPod();
    const packages = new HostedPackages({ podUrl: POD, fetch: pod.fetchImpl });
    await packages.keep(PACKAGE, ABOUT);
    const app = express();
    attachHostedPackageRoutes(app, {
      packages, bridgeBaseUrl: BRIDGE,
      courseFor: async (sha) => (sha === SHA ? hostedPackageCourse(BRIDGE, SHA, ABOUT) : undefined),
      onError: (res, err) => { res.status(500).json({ error: String(err) }); },
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => server.once('listening', () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

  it('sends every file in the sandbox, with no referrer and no type sniffing', async () => {
    for (const file of ['index.html', 'app.js', 'media/Diagram.svg', 'old.htm']) {
      const r = await fetch(`${base}/scorm/packages/${SHA}/files/${file}`);
      expect(r.status, file).toBe(200);
      expect(r.headers.get('content-security-policy'), file).toBe(PACKAGE_SANDBOX);
      expect(r.headers.get('x-content-type-options')).toBe('nosniff');
      expect(r.headers.get('referrer-policy')).toBe('no-referrer');
    }
  });

  it('puts the runtime into documents, fresh each time, and sends everything else as it is, to be kept', async () => {
    const page = await fetch(`${base}/scorm/packages/${SHA}/files/index.html?endpoint=x`);
    expect(page.headers.get('content-type')).toMatch(/^text\/html/);
    expect(page.headers.get('cache-control')).toBe('no-store');
    expect(await page.text()).toBe(PAGE.replace('<head>', `<head><script>${SANDBOX_BOOTSTRAP}</script><script src="${BRIDGE}/scorm/runtime/scorm-rte.js"></script>`));
    const script = await fetch(`${base}/scorm/packages/${SHA}/files/app.js`);
    expect(script.headers.get('content-type')).toMatch(/^text\/javascript/);
    expect(script.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(await script.text()).toBe('window.appLoaded = true;');
    // An XHTML document goes out as XML that still parses, the runtime in it.
    const xhtml = await fetch(`${base}/scorm/packages/${SHA}/files/page.xhtml`);
    expect(xhtml.headers.get('content-type')).toMatch(/^application\/xhtml\+xml/);
    const parsed = new (new JSDOM('').window.DOMParser)().parseFromString(await xhtml.text(), 'application/xhtml+xml');
    expect(parsed.getElementsByTagName('parsererror')).toHaveLength(0);
    expect(parsed.getElementsByTagName('script')[0]!.textContent).toBe(SANDBOX_BOOTSTRAP);
    // A path is decoded once: a file named with a space is found by its encoded name.
    const picture = await fetch(`${base}/scorm/packages/${SHA}/files/media/big%20picture.png`);
    expect(picture.status).toBe(200);
    expect(picture.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await picture.arrayBuffer()).equals(PNG)).toBe(true);
  });

  it('answers a path that leaves the package, or a file or package it does not have, with nothing', async () => {
    for (const path of ['%2e%2e/%2e%2e/etc/passwd', 'media%2F..%2Findex.html', '%5Cindex.html', 'missing.html', '%E0%A4%A']) {
      const r = await fetch(`${base}/scorm/packages/${SHA}/files/${path}`);
      expect(r.status, path).toBeGreaterThanOrEqual(400);
      expect(r.status, path).toBeLessThan(500);
    }
    expect((await fetch(`${base}/scorm/packages/${'0'.repeat(64)}/files/index.html`)).status).toBe(404);
  });

  it('lists the packages hosted here, each with its course, and one way to launch any of them', async () => {
    const listing = await (await fetch(`${base}/scorm/packages`)).json() as {
      kind: string; packages: Array<{ packageSha256: string; href: string; course: { id: string; title: string }; aus: unknown[] }>;
      launch: { toolName: string; target: string };
    };
    expect(listing.kind).toBe('hosted-scorm-packages');
    expect(listing.packages).toEqual([{
      packageSha256: SHA, href: `${BRIDGE}/scorm/packages/${SHA}`,
      course: { id: `${BRIDGE}/scorm/packages/${SHA}`, title: 'Refunds, hosted' }, aus: [{ id: `${BRIDGE}/scorm/packages/${SHA}/au/0`, title: 'Refunds, hosted' }],
    }]);
    expect(listing.launch).toMatchObject({ toolName: 'foxxi.cmi5_launch_signed', target: `${BRIDGE}/agent/cmi5/launch` });
  });

  it('serves the runtime, and the package\'s own record says how to launch it', async () => {
    const rt = await fetch(`${base}/scorm/runtime/scorm-rte.js`);
    expect(rt.headers.get('content-type')).toMatch(/^text\/javascript/);
    expect(await rt.text()).toBe(scormRuntimeSource());
    const record = await (await fetch(`${base}/scorm/packages/${SHA}`)).json() as { course: { id: string }; aus: unknown[]; launch: { target: string; payload: { course_id: string } } };
    expect(record.course.id).toBe(`${BRIDGE}/scorm/packages/${SHA}`);
    expect(record.aus).toHaveLength(1);
    expect(record.launch).toMatchObject({ target: `${BRIDGE}/agent/cmi5/launch`, payload: { course_id: record.course.id } });
    expect((await fetch(`${base}/scorm/packages/${'1'.repeat(64)}`)).status).toBe(404);
  });
});

describe('an upload is hosted through a hook the upload takes, so its declines stay its own', () => {
  /** A pod that takes every write and holds nothing to read. */
  const anyPod = (async (_input: unknown, init?: { method?: string }) => new Response('', { status: (init?.method ?? 'GET').toUpperCase() === 'GET' ? 404 : 201 })) as never;

  it('hands a parsed package\'s own bytes to the host, and answers with what it says, never over the upload\'s own answer', async () => {
    let seen: { bytes: Buffer; title: string } | null = null;
    const r = await uploadScormPackage({
      tenantPodUrl: POD, zipBase64: PACKAGE.toString('base64'), uploaderDid: 'did:web:admin.example', fetch: anyPod,
      host: async (bytes, parsed) => { seen = { bytes, title: parsed.packageTitle }; return { hosted: true, packageSha256: sha256Of(bytes), status: 'overridden' }; },
    });
    expect(r.status).toBe('parsed');
    expect(r).toMatchObject({ hosted: true, packageSha256: SHA });
    expect(seen!.bytes.equals(PACKAGE)).toBe(true);
    expect(seen!.title).toBe('Refunds, hosted');
  });

  it('does not reach the host with a package it declined, and types the decline', async () => {
    let called = false;
    const r = await uploadScormPackage({
      tenantPodUrl: POD, zipBase64: Buffer.from('not a zip at all').toString('base64'), uploaderDid: 'did:web:admin.example', fetch: anyPod,
      host: async () => { called = true; return {}; },
    });
    expect(called).toBe(false);
    expect(r).toMatchObject({ status: 'failed', kind: 'refusal', 'iep:refusalStatus': 400 });
  });
});

describe('the listing answers without opening a package (Codex, on #550)', () => {
  type Listing = { packages: Array<{ course: { title: string } }>; unlisted?: number; unlistedWhy?: string };
  let server: Server;
  let base = '';
  let release: () => void = () => {};
  let packages: HostedPackages;
  const pod = standInPod();
  beforeAll(async () => {
    const first = new HostedPackages({ podUrl: POD, fetch: pod.fetchImpl });
    await first.keep(PACKAGE);
    await first.keep(makeRetitled('Returns, hosted'), { title: 'Returns, hosted', launchable: ['index.html'] });
    // Every read of a package's zip waits until the test lets it through.
    const gate = new Promise<void>(r => { release = r; });
    const gated = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('.zip') && (init?.method ?? 'GET') === 'GET') await gate;
      return pod.fetchImpl(input, init);
    }) as typeof fetch;
    packages = new HostedPackages({ podUrl: POD, fetch: gated, describePackage });
    const app = express();
    attachHostedPackageRoutes(app, { packages, bridgeBaseUrl: BRIDGE, courseFor: async () => undefined, onError: (res, err) => { res.status(500).json({ error: String(err) }); } });
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => server.once('listening', () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => { release(); await new Promise<void>((r) => server.close(() => r())); });

  it('lists what is described while a package with nothing beside it waits to be read, and lists that one once it has been', async () => {
    // The zip cannot be read yet, so a listing that waited on it would not answer.
    const cold = await (await fetch(`${base}/scorm/packages`)).json() as Listing;
    expect(cold.packages.map(p => p.course.title)).toEqual(['Returns, hosted']);
    expect(cold.unlisted).toBe(1);
    expect(cold.unlistedWhy).toMatch(/in the background/);
    release();
    await packages.whenDescribed();
    const warm = await (await fetch(`${base}/scorm/packages`)).json() as Listing;
    expect(warm.packages.map(p => p.course.title).sort()).toEqual(['Refunds, hosted', 'Returns, hosted']);
    expect(warm.unlisted).toBeUndefined();
    expect(zipReads(pod.asked)).toBe(1);
  });
});

describe('in a page that may not use storage, the runtime reports through the launch\'s own token', () => {
  const ENDPOINT = `${BRIDGE}/xapi`;
  const FETCH = `${BRIDGE}/cmi5/fetch/one-time`;
  const REG = '7f1c2d3e-0000-4000-8000-000000000001';
  const ACTIVITY = `${BRIDGE}/scorm/packages/${SHA}/au/0`;
  const ACTOR = { objectType: 'Agent', account: { homePage: 'https://id.example', name: 'did:ethr:0x1111111111111111111111111111111111111111' } };
  const SESSION = 'https://w3id.org/xapi/cmi5/context/extensions/sessionid';
  interface Page { eval(src: string): void; localStorage: Storage; fetch: unknown; parent: unknown; __foxxiPlayerConfig?: { ready?: Promise<unknown> }; API_1484_11: Record<string, (...a: string[]) => string> }

  /** A sandboxed page: storage throws, and fetch goes to a stand-in bridge that records what it is sent. */
  function page(url: string, opts: { tokenGate?: Promise<void> } = {}) {
    const dom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>', { runScripts: 'outside-only', url });
    const w = dom.window as unknown as Page;
    for (const name of ['localStorage', 'sessionStorage']) {
      Object.defineProperty(w, name, { configurable: true, get() { throw new Error('SecurityError: the document is sandboxed and lacks the allow-same-origin flag'); } });
    }
    const sent: Array<{ method: string; url: string; auth?: string; body?: Record<string, unknown> }> = [];
    w.fetch = async (u: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
      const method = init.method ?? 'GET';
      sent.push({ method, url: u, auth: init.headers?.Authorization, ...(init.body ? { body: JSON.parse(init.body) as Record<string, unknown> } : {}) });
      if (method === 'POST' && u === FETCH) { await opts.tokenGate; return { ok: true, status: 200, json: async () => ({ 'auth-token': 'TOKEN' }) }; }
      if (method === 'GET' && u.startsWith(`${ENDPOINT}/activities/state?`)) {
        return { ok: true, status: 200, json: async () => ({ contextTemplate: { registration: REG, contextActivities: { category: [{ id: 'https://w3id.org/xapi/cmi5/context/categories/cmi5' }] }, extensions: { [SESSION]: 'session-1' } } }) };
      }
      return { ok: true, status: 204, json: async () => ({}) };
    };
    w.parent = w;
    w.eval(SANDBOX_BOOTSTRAP);
    w.eval(scormRuntimeSource());
    return { w, sent };
  }
  const launched = `${BRIDGE}/scorm/packages/${SHA}/files/index.html?` + new URLSearchParams({ endpoint: ENDPOINT, fetch: FETCH, actor: JSON.stringify(ACTOR), registration: REG, activityId: ACTIVITY }).toString();
  /** Wait until the stand-in bridge has been sent what is expected, or a second has passed. */
  const settle = async (done: () => boolean) => { for (let i = 0; i < 200 && !done(); i++) await new Promise(r => setTimeout(r, 5)); };

  it('stands in for web storage, so the content and the runtime can use it', () => {
    const { w } = page(`${BRIDGE}/scorm/packages/${SHA}/files/index.html`);
    w.localStorage.setItem('k', 'v');
    expect(w.localStorage.getItem('k')).toBe('v');
    expect(w.API_1484_11.Initialize!('')).toBe('true');
  });

  it('sends each statement once it holds the token, as the launch\'s actor, about the AU, in its registration and session', async () => {
    const { w, sent } = page(launched);
    const api = w.API_1484_11;
    expect(api.Initialize!('')).toBe('true');
    expect(api.SetValue!('cmi.completion_status', 'completed')).toBe('true');
    expect(api.SetValue!('cmi.success_status', 'passed')).toBe('true');
    expect(api.SetValue!('cmi.score.scaled', '0.9')).toBe('true');
    expect(api.Commit!('')).toBe('true');
    expect(api.Terminate!('')).toBe('true');
    await settle(() => sent.filter(s => s.method === 'PUT').length >= 4);
    expect(sent.filter(s => s.method === 'POST' && s.url === FETCH)).toHaveLength(1);
    const statements = sent.filter(s => s.method === 'PUT');
    expect(statements.map(s => String((s.body!.verb as { id: string }).id).split('/').pop())).toEqual(['initialized', 'completed', 'passed', 'terminated']);
    for (const s of statements) {
      expect(s.url.startsWith(`${ENDPOINT}/statements?statementId=`)).toBe(true);
      expect(s.auth).toBe('Basic TOKEN');
      expect(s.body!.actor).toEqual(ACTOR);
      expect((s.body!.object as { id: string }).id).toBe(ACTIVITY);
      const ctx = s.body!.context as { registration: string; extensions: Record<string, unknown>; contextActivities: Record<string, unknown> };
      expect(ctx.registration).toBe(REG);
      expect(ctx.extensions[SESSION]).toBe('session-1');
      expect(ctx.contextActivities.parent).toBeUndefined();
      expect(ctx.contextActivities.grouping).toBeUndefined();
    }
  });

  it('sends nothing until the launch has handed over its token', async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    const { w, sent } = page(launched, { tokenGate: gate });
    expect(w.API_1484_11.Initialize!('')).toBe('true');
    await new Promise(r => setTimeout(r, 30));
    expect(sent.filter(s => s.method === 'PUT')).toHaveLength(0);
    open();
    await settle(() => sent.some(s => s.method === 'PUT'));
    const put = sent.find(s => s.method === 'PUT');
    expect(put?.auth).toBe('Basic TOKEN');
  });

  it('asks for nothing on a page opened without a launch', async () => {
    const { w, sent } = page(`${BRIDGE}/scorm/packages/${SHA}/files/index.html`);
    expect(w.__foxxiPlayerConfig).toBeUndefined();
    w.API_1484_11.Initialize!('');
    await new Promise(r => setTimeout(r, 30));
    expect(sent).toEqual([]);
  });
});

describe('the bridge hosts what is uploaded, and restores it after a restart', () => {
  const server = readFileSync(new URL('../bridge/server.ts', import.meta.url), 'utf8');
  it('keeps a parsed upload and makes it a course; a launch restores it from the package itself', () => {
    const upload = server.slice(server.indexOf("'foxxi.upload_scorm_package': async"), server.indexOf("'foxxi.derive_adaptive_policy'"));
    // The upload's answer is the handler's, returned as a tail call: the census of handler
    // answers follows it into uploadScormPackage and reads its declines (tests/handler-delegation-reach.ts).
    expect(upload).toMatch(/\n {4}return uploadScormPackage\(\{\n[\s\S]*\n {6}host: \(bytes, parsed\) => hostUploadedPackage\(bytes, parsed\.packageTitle, parsed\.launchable\),\n {4}\}\);\n {2}\},/);
    const launch = server.slice(server.indexOf("app.post('/agent/cmi5/launch'"), server.indexOf("app.post('/agent/cmi5/launch'") + 1500);
    expect(launch).toMatch(/restorePublishedCourse\(DEFAULT_TENANT, courseId\);[^\n]*\n\s+if \(!getCmi5Course\(DEFAULT_TENANT, courseId\)\) await restoreHostedPackage\(courseId\);\n\s+const course = getCmi5Course\(DEFAULT_TENANT, courseId\);/);
    expect(server).toMatch(/attachHostedPackageRoutes\(app, \{\n\s+packages: hostedPackages,\n\s+bridgeBaseUrl,/);
    expect(server).toContain('const hostedPackages = new HostedPackages({ podUrl: tenantPodUrl, describePackage: describeHostedPackage });');
  });

  it('keeps what an upload is beside it, and restores from that, describing a package itself as an upload is parsed', () => {
    const host = server.slice(server.indexOf('async function hostUploadedPackage('), server.indexOf('async function restoreHostedPackage('));
    expect(host).toContain('const about: PackageAbout = { title, launchable: launchable.filter(isPackagePath) };');
    expect(host).toContain('try { kept = await hostedPackages.keep(bytes, about); }');
    expect(host).toContain('const course = hostedPackageCourse(bridgeBaseUrl, kept.sha256, about);');
    const restore = server.slice(server.indexOf('async function restoreHostedPackage('), server.indexOf('attachHostedPackageRoutes(app, {'));
    expect(restore).toContain('const about = await hostedPackages.aboutNow(sha);');
    expect(restore).not.toContain('unwrapScormPackage');
    // Described as an upload is parsed: under the same inflation budget, before anything is inflated.
    const describe = server.slice(server.indexOf('function describeHostedPackage('), server.indexOf('async function hostUploadedPackage('));
    expect(describe).toMatch(/if \(declaredUncompressedBytes\(bytes\) > uncompressedBudget\(bytes\.length\)\) return null;\n\s+const pkg = unwrapScormPackage\(bytes\);/);
  });

  it('is reached by the census of handler answers, so an untyped decline in the upload is caught', async () => {
    const { delegationsIn } = await import('../../../tests/handler-delegation-reach.js');
    const upload = delegationsIn(fileURLToPath(new URL('../bridge/server.ts', import.meta.url))).find(d => d.tool === 'foxxi.upload_scorm_package');
    expect(upload?.fn).toBe('uploadScormPackage');
    expect(upload?.module).toMatch(/composed-extensions\.ts$/);
  });

  it('lets the runtime PUT its statements from another origin, and grants no credentials to any', () => {
    // A statement is PUT with its id; a preflight listing only GET and POST refused every one the
    // runtime sent, from the player's origin and from a package's sandbox alike.
    expect(server).toContain("res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');");
    expect(server).not.toMatch(/setHeader\('Access-Control-Allow-Credentials'/);
  });

  it('ships the runtime in the bridge image, the same file the player serves', () => {
    const dockerfile = readFileSync(new URL('../../../deploy/Dockerfile.foxxi-bridge', import.meta.url), 'utf8');
    expect(dockerfile).toContain('COPY deploy/foxxi-scorm-player/site/scorm-rte.js ./deploy/foxxi-scorm-player/site/scorm-rte.js');
    expect(scormRuntimeSource()).toBe(readFileSync(new URL('../../../deploy/foxxi-scorm-player/site/scorm-rte.js', import.meta.url), 'utf8'));
  });
});
