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
import AdmZip from 'adm-zip';
import { JSDOM } from 'jsdom';
import {
  HostedPackages, PACKAGE_SANDBOX, SANDBOX_BOOTSTRAP, attachHostedPackageRoutes, contentTypeOf, hostedPackageCourse,
  hostedPackageOf, isHtmlDocument, packageEntry, scormRuntimeSource, sha256Of, withRuntime,
} from '../src/scorm-hosting.js';
import { unwrapScormPackage } from '../../_shared/scorm/index.js';

const BRIDGE = 'https://bridge.example';
const POD = 'https://pod.example/foxxi/';
const MANIFEST = '<?xml version="1.0"?><manifest identifier="pkg" xmlns="http://www.imsglobal.org/xsd/imscp_v1p1" xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_v1p3">'
  + '<organizations default="o"><organization identifier="o"><title>Refunds, hosted</title><item identifier="i1" identifierref="r1"><title>Refunds</title></item></organization></organizations>'
  + '<resources><resource identifier="r1" type="webcontent" adlcp:scormType="sco" href="index.html"><file href="index.html"/></resource></resources></manifest>';
const PAGE = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Refunds</title><script src="app.js"></script></head><body><h1>Refunds</h1></body></html>';
/** A page in another encoding: its bytes must go out as they came in. */
const LATIN1_PAGE = Buffer.concat([Buffer.from('<html><head><meta charset="windows-1252"></head><body>caf', 'latin1'), Buffer.from([0xe9]), Buffer.from('</body></html>', 'latin1')]);

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function makePackage(): Buffer {
  const zip = new AdmZip();
  zip.addFile('imsmanifest.xml', Buffer.from(MANIFEST, 'utf8'));
  zip.addFile('index.html', Buffer.from(PAGE, 'utf8'));
  zip.addFile('app.js', Buffer.from('window.appLoaded = true;', 'utf8'));
  zip.addFile('media/Diagram.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'utf8'));
  zip.addFile('old.htm', LATIN1_PAGE);
  zip.addFile('media/big picture.png', PNG);
  return zip.toBuffer();
}
const PACKAGE = makePackage();
const SHA = sha256Of(PACKAGE);

/** A stand-in pod: a map of resources, and a record of what was asked of it. */
function standInPod() {
  const kept = new Map<string, Buffer>();
  const asked: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    asked.push(`${init?.method ?? 'GET'} ${url}`);
    if (init?.method === 'PUT') { kept.set(url, Buffer.from(await new Response(init.body as BodyInit).arrayBuffer())); return new Response(null, { status: 201 }); }
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
    for (const unsafe of ['\\', '`', '${', '</script', '<!--']) expect(SANDBOX_BOOTSTRAP.includes(unsafe), unsafe).toBe(false);
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

  it('is kept on the pod under its sha-256, and read back only when its bytes still hash to it', async () => {
    const pod = standInPod();
    const kept = await new HostedPackages({ podUrl: POD, fetch: pod.fetchImpl }).keep(PACKAGE);
    expect(kept).toEqual({ sha256: SHA, url: `${POD}foxxi-uploads/packages/${SHA}.zip` });
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
    await packages.keep(PACKAGE);
    const app = express();
    attachHostedPackageRoutes(app, {
      packages, bridgeBaseUrl: BRIDGE,
      courseFor: async (sha) => (sha === SHA ? hostedPackageCourse(BRIDGE, SHA, { title: 'Refunds, hosted', launchable: ['index.html'] }) : undefined),
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
    expect(upload).toContain("if (upload.status !== 'parsed' || !upload.parsed) return upload;");
    expect(upload).toContain("const hosted = await hostUploadedPackage(Buffer.from(args.zip_base64 as string, 'base64'), upload.parsed.packageTitle, upload.parsed.launchable);");
    const launch = server.slice(server.indexOf("app.post('/agent/cmi5/launch'"), server.indexOf("app.post('/agent/cmi5/launch'") + 1500);
    expect(launch).toMatch(/restorePublishedCourse\(DEFAULT_TENANT, courseId\);[^\n]*\n\s+if \(!getCmi5Course\(DEFAULT_TENANT, courseId\)\) await restoreHostedPackage\(courseId\);\n\s+const course = getCmi5Course\(DEFAULT_TENANT, courseId\);/);
    expect(server).toMatch(/attachHostedPackageRoutes\(app, \{\n\s+packages: hostedPackages,\n\s+bridgeBaseUrl,/);
    expect(server).toContain('const hostedPackages = new HostedPackages({ podUrl: tenantPodUrl });');
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
