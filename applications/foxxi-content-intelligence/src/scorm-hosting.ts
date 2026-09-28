/**
 * SCORM packages the bridge hosts itself: each document served in a sandbox of its own.
 *
 * ★ WHY NO SECOND ORIGIN. A package is someone else's HTML and script. Served from the bridge's own
 * origin as it is, it could read what that origin keeps and act as the bridge's own pages. The usual
 * answer is a second origin just for content. The browser gives the same isolation without one: a
 * response sent with `Content-Security-Policy: sandbox` (and no `allow-same-origin`) runs in an
 * opaque origin of its own. It cannot read the bridge origin's storage or cookies or script its
 * pages, and whatever it fetches from the bridge arrives as from nowhere in particular. Scripts,
 * forms, popups and dialogs still run.
 *
 * ★ HOW CONTENT REACHES ITS LMS FROM THERE. SCORM content looks for its runtime (`window.API`,
 * `window.API_1484_11`) on its own window first, then up its parents; a parent on another origin is
 * out of reach. So each HTML document served from a package gets the runtime put into it: the SCORM
 * player's own `scorm-rte.js`, after a bootstrap that
 *  - stands in, in memory, for `localStorage` and `sessionStorage`, which a sandboxed page may not
 *    use, and which the runtime and much content reach for;
 *  - reads the cmi5 launch the page was opened with (`endpoint`, `fetch`, `actor`, `registration`,
 *    `activityId`), fetches its auth-token once, and reads `LMS.LaunchData`.
 * The runtime then turns the content's commits into that AU's cmi5 statements and sends them with
 * the token: a credential bound to one registration, never the learner's own.
 *
 * ★ PLAYED THROUGH THE LMS THE BRIDGE ALREADY RUNS. An uploaded package is a cmi5 course: one AU per
 * launchable SCO, whose URL is the SCO's file here. A learner launches it with the signed cmi5
 * launch any published course takes, and the LMS records `satisfied` when its moveOn is met. What
 * a package reports is experience, not graded evidence, since a SCO grades itself.
 *
 * ★ WHAT DOES NOT CARRY OVER. Every document is its own opaque origin. Content that scripts across
 * its own frames or windows, or keeps state across its pages in web storage, loses that: a
 * single-document SCO (what current authoring tools export) runs, and a frameset whose frames
 * script each other does not.
 *
 * ★ KEPT BY WHAT IT IS. A package is kept on the tenant pod under its sha-256, and read back only
 * when its bytes still hash to it.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import AdmZip from 'adm-zip';
import type { Express, Response as ExpressResponse } from 'express';
import type { Cmi5Course } from './cmi5-course.js';

/** A package's id: the sha-256 of its zip, in lowercase hex. */
export const PACKAGE_SHA = /^[0-9a-f]{64}$/;

/**
 * The sandbox every response from a package is sent in: scripts, forms, popups and dialogs run,
 * and there is no `allow-same-origin`, so the document's origin is opaque and nothing of the
 * bridge's is its own. Popups stay in the sandbox, and nothing may navigate the top window.
 */
export const PACKAGE_SANDBOX = 'sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads';

export function sha256Of(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const TYPES: Record<string, string> = {
  html: 'text/html', htm: 'text/html', xhtml: 'application/xhtml+xml',
  js: 'text/javascript', mjs: 'text/javascript', css: 'text/css', json: 'application/json',
  xml: 'application/xml', xsd: 'application/xml', txt: 'text/plain', vtt: 'text/vtt', csv: 'text/csv',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', ico: 'image/x-icon', bmp: 'image/bmp',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac',
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', eot: 'application/vnd.ms-fontobject',
  pdf: 'application/pdf', wasm: 'application/wasm',
};

/** A file's media type, from its extension; anything unknown is plain bytes. */
export function contentTypeOf(path: string): string {
  const ext = path.toLowerCase().split('.').pop() ?? '';
  return TYPES[ext] ?? 'application/octet-stream';
}

/** Whether a file is a document the runtime goes into. */
export function isHtmlDocument(path: string): boolean {
  return /\.(?:html?|xhtml)$/i.test(path);
}

/**
 * The entry a request names, or null. The path is taken once decoded, and must be relative, with
 * no dot segments, empty segments, backslashes or NULs: a path never leaves the package. It names
 * an entry exactly, or case-folded when exactly one entry matches that way (packages made on
 * case-insensitive disks often link with other casing).
 */
export function packageEntry(zip: AdmZip, path: string): AdmZip.IZipEntry | null {
  if (!path || path.includes('\0') || path.includes('\\') || path.startsWith('/')) return null;
  if (path.split('/').some(s => s === '' || s === '.' || s === '..')) return null;
  const files = zip.getEntries().filter(e => !e.isDirectory);
  const exact = files.find(e => e.entryName === path);
  if (exact) return exact;
  const folded = files.filter(e => e.entryName.toLowerCase() === path.toLowerCase());
  return folded.length === 1 ? folded[0]! : null;
}

/**
 * Put in front of the runtime, in every document served from a package. No backslashes, template
 * syntax or closing tags in it: it is sent as it is written.
 */
export const SANDBOX_BOOTSTRAP = String.raw`(function () {
  function memoryStorage() {
    var items = new Map();
    return {
      getItem: function (k) { k = String(k); return items.has(k) ? items.get(k) : null; },
      setItem: function (k, v) { items.set(String(k), String(v)); },
      removeItem: function (k) { items.delete(String(k)); },
      clear: function () { items.clear(); },
      key: function (i) { var keys = Array.from(items.keys()); return i < keys.length ? keys[i] : null; },
      get length() { return items.size; }
    };
  }
  ['localStorage', 'sessionStorage'].forEach(function (name) {
    var usable = false;
    try { var s = window[name]; s.setItem('foxxi-probe', '1'); s.removeItem('foxxi-probe'); usable = true; } catch (e) {}
    if (!usable) { try { Object.defineProperty(window, name, { value: memoryStorage(), configurable: true }); } catch (e) {} }
  });
  var q = new URLSearchParams(location.search);
  var endpoint = q.get('endpoint'), fetchUrl = q.get('fetch'), registration = q.get('registration'), activityId = q.get('activityId'), actor = null;
  try { actor = JSON.parse(q.get('actor') || 'null'); } catch (e) { actor = null; }
  if (!endpoint || !fetchUrl || !registration || !activityId || !actor || !actor.account) return;
  while (endpoint.charAt(endpoint.length - 1) === '/') endpoint = endpoint.slice(0, -1);
  var cfg = window.__foxxiPlayerConfig = {
    lrs: endpoint, registration: registration, courseIri: activityId, actor: actor,
    learnerDid: actor.account.name, identityServer: actor.account.homePage, learnerName: actor.name || ''
  };
  cfg.ready = fetch(fetchUrl, { method: 'POST' })
    .then(function (r) { if (!r.ok) throw new Error('the launch did not hand over its auth-token (' + r.status + ')'); return r.json(); })
    .then(function (body) {
      if (!body || typeof body['auth-token'] !== 'string') throw new Error('the launch handed over no auth-token');
      cfg.authorization = 'Basic ' + body['auth-token'];
      var state = endpoint + '/activities/state?' + new URLSearchParams({ stateId: 'LMS.LaunchData', activityId: activityId, agent: JSON.stringify(actor), registration: registration }).toString();
      return fetch(state, { headers: { Authorization: cfg.authorization, 'X-Experience-API-Version': '2.0.0' } });
    })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (data) { if (data && data.contextTemplate) cfg.contextTemplate = data.contextTemplate; });
})();`;

const attr = (s: string): string => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * A document with the runtime put into it, as bytes: after `<head>`, or else after `<html>` or the
 * doctype, or at the very start. The document is handled as latin-1, one character a byte, so
 * whatever its own encoding, every byte of it goes out as it came in. A document parsed as XML
 * (XHTML) gets the bootstrap in a CDATA section, since its `<` and `&&` are not text an XML parser
 * takes bare (Codex, on #548).
 */
export function withRuntime(document: Buffer, runtimeUrl: string, opts: { xml?: boolean } = {}): Buffer {
  const text = document.toString('latin1');
  const bootstrap = opts.xml ? `<![CDATA[${SANDBOX_BOOTSTRAP}]]>` : SANDBOX_BOOTSTRAP;
  const tags = `<script>${bootstrap}</script><script src="${attr(runtimeUrl)}"></script>`;
  const at = /<head\b[^>]*>/i.exec(text) ?? /<html\b[^>]*>/i.exec(text) ?? /^\s*<!doctype[^>]*>/i.exec(text);
  const cut = at ? at.index + at[0].length : 0;
  return Buffer.from(text.slice(0, cut) + tags + text.slice(cut), 'latin1');
}

let runtimeSource: string | undefined;
/** The SCORM runtime the player serves, read once: the same file, so there is one runtime. */
export function scormRuntimeSource(): string {
  runtimeSource ??= readFileSync(new URL('../../../deploy/foxxi-scorm-player/site/scorm-rte.js', import.meta.url), 'utf8');
  return runtimeSource;
}

/**
 * A package as a cmi5 course: one AU per launchable SCO, each launched from its file here, moving
 * on when the SCO says it completed or passed. The course's id is the package's own address.
 */
export function hostedPackageCourse(bridgeBaseUrl: string, sha256: string, pkg: { title: string; launchable: readonly string[] }): Cmi5Course {
  const root = `${bridgeBaseUrl.replace(/\/+$/, '')}/scorm/packages/${sha256}`;
  const n = pkg.launchable.length;
  return {
    id: root,
    title: pkg.title,
    structure: pkg.launchable.map((href, i) => ({
      kind: 'au' as const,
      id: `${root}/au/${i}`,
      title: n > 1 ? `${pkg.title} (${i + 1} of ${n})` : pkg.title,
      url: `${root}/files/${href.split('/').map(encodeURIComponent).join('/')}`,
      moveOn: 'CompletedOrPassed' as const,
      launchMethod: 'AnyWindow' as const,
    })),
  };
}

/** The package a hosted course's id names, or null for any other course. */
export function hostedPackageOf(bridgeBaseUrl: string, courseId: string): string | null {
  const prefix = `${bridgeBaseUrl.replace(/\/+$/, '')}/scorm/packages/`;
  if (!courseId.startsWith(prefix)) return null;
  const sha = courseId.slice(prefix.length);
  return PACKAGE_SHA.test(sha) ? sha : null;
}

/**
 * Where packages are kept (the tenant pod, under their sha-256) and the ones in hand. What is read
 * back is checked against its id before it is used; a zip that does not hash to it is not the
 * package, and is treated as absent.
 */
export class HostedPackages {
  private readonly held = new Map<string, { zip: AdmZip; bytes: number }>();
  private heldBytes = 0;

  constructor(private readonly opts: { podUrl: string; fetch?: typeof fetch; maxHeldBytes?: number }) {}

  /** The pod container packages are kept in. */
  containerUrl(): string {
    return `${this.opts.podUrl.replace(/\/*$/, '/')}foxxi-uploads/packages/`;
  }

  /** The pod resource a package is kept at. */
  urlOf(sha256: string): string {
    return `${this.containerUrl()}${sha256}.zip`;
  }

  /** Keep a package's bytes on the pod, under their sha-256. Throws when the pod does not take them. */
  async keep(bytes: Buffer): Promise<{ sha256: string; url: string }> {
    const sha256 = sha256Of(bytes);
    const url = this.urlOf(sha256);
    const fetchFn = this.opts.fetch ?? globalThis.fetch;
    // A Solid store does not always make the parent of a PUT, and on a fresh tenant pod nothing has
    // made this one (Codex, on #548). Make it first, as the shared lattice does its own: best
    // effort, since a container that already exists answers however it does.
    try {
      await fetchFn(this.containerUrl(), {
        method: 'PUT', headers: { 'Content-Type': 'text/turtle', Link: '<http://www.w3.org/ns/ldp#BasicContainer>; rel="type"' }, body: '',
      });
    } catch { /* best effort */ }
    const r = await fetchFn(url, { method: 'PUT', headers: { 'Content-Type': 'application/zip' }, body: new Blob([new Uint8Array(bytes)], { type: 'application/zip' }) });
    if (!r.ok) throw new Error(`the pod did not keep the package (HTTP ${r.status})`);
    this.hold(sha256, new AdmZip(bytes), bytes.length);
    return { sha256, url };
  }

  /** A package, from memory or the pod, or null when it is not kept or its bytes are not what its id says. */
  async open(sha256: string): Promise<AdmZip | null> {
    if (!PACKAGE_SHA.test(sha256)) return null;
    const had = this.held.get(sha256);
    if (had) { this.held.delete(sha256); this.held.set(sha256, had); return had.zip; }
    let r: Response;
    try { r = await (this.opts.fetch ?? globalThis.fetch)(this.urlOf(sha256), { headers: { Accept: 'application/zip' } }); }
    catch { return null; }
    if (!r.ok) return null;
    const bytes = Buffer.from(await r.arrayBuffer());
    if (sha256Of(bytes) !== sha256) return null;
    const zip = new AdmZip(bytes);
    this.hold(sha256, zip, bytes.length);
    return zip;
  }

  /**
   * The packages kept here: those the pod's package container lists, and any held in memory, at most
   * `max`. A pod that cannot be read gives the held ones.
   */
  async list(max = 200): Promise<string[]> {
    const shas = new Set<string>();
    try {
      const r = await (this.opts.fetch ?? globalThis.fetch)(this.containerUrl(), { headers: { Accept: 'text/turtle' } });
      if (r.ok) for (const m of (await r.text()).matchAll(/([0-9a-f]{64})\.zip\b/g)) shas.add(m[1]!);
    } catch { /* the pod did not answer: what is held is what can be listed */ }
    for (const sha of this.held.keys()) shas.add(sha);
    return [...shas].slice(0, max);
  }

  private hold(sha256: string, zip: AdmZip, bytes: number): void {
    const cap = this.opts.maxHeldBytes ?? 256 * 1024 * 1024;
    if (this.held.has(sha256)) return;
    this.held.set(sha256, { zip, bytes });
    this.heldBytes += bytes;
    for (const [k, v] of this.held) {
      if (this.heldBytes <= cap || k === sha256) break;
      this.held.delete(k);
      this.heldBytes -= v.bytes;
    }
  }
}

const PACKAGE_RECORD = /^\/scorm\/packages\/([0-9a-f]{64})$/;
const PACKAGE_FILE = /^\/scorm\/packages\/([0-9a-f]{64})\/files\/(.+)$/;

/**
 * The routes a hosted package is reached by: the runtime its documents load, the package's own
 * record (its course, and how to launch it), and its files, each in the package's sandbox.
 */
export function attachHostedPackageRoutes(app: Express, deps: {
  packages: HostedPackages;
  bridgeBaseUrl: string;
  /** The course a hosted package is, restored from the package when this process has not seen it. */
  courseFor: (sha256: string) => Promise<Cmi5Course | undefined>;
  onError: (res: ExpressResponse, err: unknown, where: string) => void;
}): void {
  const base = deps.bridgeBaseUrl.replace(/\/+$/, '');
  const runtimeUrl = `${base}/scorm/runtime/scorm-rte.js`;

  app.get('/scorm/runtime/scorm-rte.js', (_req, res) => {
    res.set('Content-Type', 'text/javascript; charset=utf-8').set('X-Content-Type-Options', 'nosniff').set('Cache-Control', 'public, max-age=3600');
    res.send(scormRuntimeSource());
  });

  /**
   * The packages hosted here, each with its course, and one way to launch any of them: the signed
   * cmi5 launch, for the signer, naming the package's course. Read by a learner's page and by an
   * agent alike; nothing in it is anyone's record.
   */
  app.get('/scorm/packages', async (_req, res) => {
    try {
      const packages: Array<Record<string, unknown>> = [];
      for (const sha of await deps.packages.list()) {
        const course = await deps.courseFor(sha);
        if (!course) continue;
        packages.push({
          packageSha256: sha, href: `${base}/scorm/packages/${sha}`,
          course: { id: course.id, title: course.title }, aus: course.structure.map(a => ({ id: a.id, title: a.title })),
        });
      }
      res.json({
        kind: 'hosted-scorm-packages', packages,
        launch: {
          toolName: 'foxxi.cmi5_launch_signed', method: 'POST', target: `${base}/agent/cmi5/launch`, payload: '{ course_id: <a package\'s course.id> }',
          note: 'Signed as the learner: the launch is for the signer, and answers with the launchUrl to open. What the package reports lands in their own record, as experience.',
        },
      });
    } catch (err) { deps.onError(res, err, 'hosted-packages'); }
  });

  app.get(PACKAGE_RECORD, async (req, res) => {
    try {
      const sha = PACKAGE_RECORD.exec(req.path)?.[1] ?? '';
      const course = await deps.courseFor(sha);
      if (!course) { res.status(404).json({ error: 'no package with that sha-256 is hosted here' }); return; }
      res.json({
        kind: 'hosted-scorm-package', packageSha256: sha, course: { id: course.id, title: course.title },
        aus: course.structure.map(a => ({ id: a.id, title: a.title })),
        launch: {
          method: 'POST', target: `${base}/agent/cmi5/launch`, payload: { course_id: course.id },
          note: 'Signed as the learner: the launch is for the signer, and what the package reports lands in their own record, as experience.',
        },
      });
    } catch (err) { deps.onError(res, err, 'hosted-package'); }
  });

  /**
   * A file of a hosted package, in the package's sandbox. Every response carries it, so anything a
   * browser renders from a package (HTML, SVG, a PDF) runs in an opaque origin; and none sends a
   * referrer, since a launch's URL holds its one-time token fetch. Documents get the runtime put
   * into them; everything else goes out as it is in the zip. The path is decoded once, here.
   */
  app.get(PACKAGE_FILE, async (req, res) => {
    try {
      const m = PACKAGE_FILE.exec(req.path);
      if (!m) { res.status(404).end(); return; }
      let path: string;
      try { path = decodeURIComponent(m[2]!); } catch { res.status(400).json({ error: 'the file path is not validly encoded' }); return; }
      const zip = await deps.packages.open(m[1]!);
      if (!zip) { res.status(404).json({ error: 'no package with that sha-256 is hosted here' }); return; }
      const entry = packageEntry(zip, path);
      if (!entry) { res.status(404).json({ error: 'the package has no such file' }); return; }
      res.set('Content-Security-Policy', PACKAGE_SANDBOX)
        .set('X-Content-Type-Options', 'nosniff')
        .set('Referrer-Policy', 'no-referrer')
        .set('Content-Type', contentTypeOf(entry.entryName));
      if (isHtmlDocument(entry.entryName)) {
        res.set('Cache-Control', 'no-store').send(withRuntime(entry.getData(), runtimeUrl, { xml: contentTypeOf(entry.entryName) === 'application/xhtml+xml' }));
        return;
      }
      res.set('Cache-Control', 'public, max-age=31536000, immutable').send(entry.getData());
    } catch (err) { deps.onError(res, err, 'hosted-package-file'); }
  });
}
