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
 * when its bytes still hash to it. What it is (its title and SCOs) is kept beside it, so the
 * packages here are listed without opening any of them. An authoring tool's own export (an .h5p
 * file, an Adapt course exported as source) is kept the same way, described as one: it launches
 * nothing, and is kept to be folded.
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
 * Whether a path is one inside a package: relative, with no dot segments, empty segments,
 * backslashes or NULs. A path that is not never leaves the package, served or launched.
 */
export function isPackagePath(path: string): boolean {
  if (!path || path.includes('\0') || path.includes('\\') || path.startsWith('/')) return false;
  return !path.split('/').some(s => s === '' || s === '.' || s === '..');
}

/**
 * The entry a request names, or null. The path is taken once decoded, and must be a package path
 * (above). It names an entry exactly, or case-folded when exactly one entry matches that way
 * (packages made on case-insensitive disks often link with other casing).
 */
export function packageEntry(zip: AdmZip, path: string): AdmZip.IZipEntry | null {
  if (!isPackagePath(path)) return null;
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
 * on when the SCO says it completed or passed. The course's id is the package's own address. A SCO
 * whose path is not a package path is not an AU: its launch URL, resolved, would leave the
 * package's files for another of the bridge's routes.
 */
export function hostedPackageCourse(bridgeBaseUrl: string, sha256: string, pkg: PackageAbout): Cmi5Course {
  const root = `${bridgeBaseUrl.replace(/\/+$/, '')}/scorm/packages/${sha256}`;
  const launchable = pkg.launchable.filter(isPackagePath);
  const n = launchable.length;
  return {
    id: root,
    title: pkg.title,
    structure: launchable.map((href, i) => ({
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
 * What a package is, kept beside it on the pod so it can be listed without being opened: its title
 * and the SCOs it launches. It describes the package and is not the package: files are served only
 * from bytes that hash to the package's id, and a description names only package paths, so the
 * most one could misstate is a title, or which of the package's own files a launch opens.
 *
 * An authoring tool's own export (an .h5p file, an Adapt course exported as source) is kept here
 * too, to be folded (src/tool-exports.ts): no SCORM package, it launches nothing, and its
 * description names the tool instead (`exportOf`).
 */
export interface PackageAbout {
  title: string;
  launchable: readonly string[];
  /** The authoring tool whose own export this is, when it is one; it then launches nothing. */
  exportOf?: string;
}

/** A description read back from beside a package, when it is one of that package: with something to launch, or an export. */
export function aboutFrom(sha256: string, body: unknown): PackageAbout | null {
  const b = body as { packageSha256?: unknown; title?: unknown; launchable?: unknown; exportOf?: unknown } | null;
  if (!b || b.packageSha256 !== sha256 || typeof b.title !== 'string' || !Array.isArray(b.launchable)) return null;
  // An export launches nothing, whatever a description beside it says.
  const exportOf = typeof b.exportOf === 'string' ? b.exportOf.trim() : '';
  if (exportOf) return { title: b.title, launchable: [], exportOf };
  const launchable = b.launchable.filter((p): p is string => typeof p === 'string' && isPackagePath(p));
  return launchable.length ? { title: b.title, launchable } : null;
}

/** The answer already on its way for a key, or new work, forgotten once it arrives. */
function once<T>(inFlight: Map<string, Promise<T>>, key: string, work: () => Promise<T>): Promise<T> {
  const had = inFlight.get(key);
  if (had) return had;
  const p = work().finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

/**
 * Where packages are kept (the tenant pod, under their sha-256) and the ones in hand. What is read
 * back is checked against its id before it is used; a zip that does not hash to it is not the
 * package, and is treated as absent.
 *
 * ★ A LISTING OPENS NO PACKAGE (Codex, on #550). Each package's description is kept beside it, and
 * a listing reads that. A package kept with none (before descriptions were kept, or when the pod
 * did not take one) is described from the package itself in the background, one package at a
 * time, and its description kept, so it is opened for that once rather than once a listing. However
 * many ask for the same package at once, it is read from the pod once.
 */
export class HostedPackages {
  private readonly held = new Map<string, { zip: AdmZip; bytes: number }>();
  private heldBytes = 0;
  private readonly reading = new Map<string, Promise<Buffer | null>>();
  private readonly abouts = new Map<string, PackageAbout>();
  private readonly aboutReads = new Map<string, Promise<PackageAbout | null>>();
  private readonly describing = new Map<string, Promise<PackageAbout | null>>();
  /** Packages the background could not describe, and when it may try each again. */
  private readonly undescribed = new Map<string, number>();
  private readonly queue: string[] = [];
  private drained: Promise<void> = Promise.resolve();
  private draining = false;

  constructor(private readonly opts: {
    podUrl: string; fetch?: typeof fetch; maxHeldBytes?: number;
    /** What a package's bytes say it is (a package with something to launch, or a tool's own export), or null when neither. */
    describePackage?: (bytes: Buffer) => PackageAbout | null;
    /** How long the background leaves a package it could not describe before trying it again. */
    retryAfterMs?: number;
  }) {}

  /** The pod container packages are kept in. */
  containerUrl(): string {
    return `${this.opts.podUrl.replace(/\/*$/, '/')}foxxi-uploads/packages/`;
  }

  /** The pod resource a package is kept at. */
  urlOf(sha256: string): string {
    return `${this.containerUrl()}${sha256}.zip`;
  }

  /** The pod resource a package's description is kept at, beside it. */
  aboutUrlOf(sha256: string): string {
    return `${this.containerUrl()}${sha256}.json`;
  }

  /**
   * Keep a package's bytes on the pod, under their sha-256, and what it is beside it when that is
   * given. Throws when the pod does not take the package.
   */
  async keep(bytes: Buffer, about?: PackageAbout): Promise<{ sha256: string; url: string }> {
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
    if (about) await this.keepAbout(sha256, about);
    return { sha256, url };
  }

  /**
   * Keep what a package is beside it, and in hand. Best effort on the pod: a package whose
   * description the pod did not take is described again from the package, once.
   */
  async keepAbout(sha256: string, about: PackageAbout): Promise<void> {
    const exportOf = about.exportOf?.trim() ?? '';
    // An export launches nothing; a package names only the SCOs inside it.
    const launchable = exportOf ? [] : about.launchable.filter(isPackagePath);
    if (!PACKAGE_SHA.test(sha256) || (!launchable.length && !exportOf)) return;
    const kept: PackageAbout = exportOf ? { title: about.title, launchable, exportOf } : { title: about.title, launchable };
    this.abouts.set(sha256, kept);
    try {
      await (this.opts.fetch ?? globalThis.fetch)(this.aboutUrlOf(sha256), {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ packageSha256: sha256, ...kept }),
      });
    } catch { /* best effort */ }
  }

  /** What a package is: in hand, or read from beside it on the pod. Null when neither has it; the package is not opened. */
  async about(sha256: string): Promise<PackageAbout | null> {
    if (!PACKAGE_SHA.test(sha256)) return null;
    const had = this.abouts.get(sha256);
    if (had) return had;
    return once(this.aboutReads, sha256, async () => {
      try {
        const r = await (this.opts.fetch ?? globalThis.fetch)(this.aboutUrlOf(sha256), { headers: { Accept: 'application/json' } });
        if (!r.ok) return null;
        const about = aboutFrom(sha256, await r.json());
        if (about) this.abouts.set(sha256, about);
        return about;
      } catch { return null; }
    });
  }

  /** What a package is, from the package itself when nothing describes it: for one package someone is about to play. */
  async aboutNow(sha256: string): Promise<PackageAbout | null> {
    return (await this.about(sha256)) ?? this.describeFromPackage(sha256);
  }

  /**
   * What a package is, when something describes it. When nothing does, the package is queued to
   * be described in the background and null is answered meanwhile: a listing opens no package
   * while its request waits.
   */
  async aboutOrLater(sha256: string): Promise<PackageAbout | null> {
    const about = await this.about(sha256);
    if (!about && PACKAGE_SHA.test(sha256)) this.later(sha256);
    return about;
  }

  /** Settles once every package queued to be described has been. */
  whenDescribed(): Promise<void> {
    return this.drained;
  }

  /** How many packages wait their turn to be described in the background. */
  get waiting(): number {
    return this.queue.length;
  }

  /** A package, from memory or the pod, or null when it is not kept or its bytes are not what its id says. */
  async open(sha256: string): Promise<AdmZip | null> {
    if (!PACKAGE_SHA.test(sha256)) return null;
    const had = this.held.get(sha256);
    if (had) { this.held.delete(sha256); this.held.set(sha256, had); return had.zip; }
    const bytes = await this.read(sha256);
    if (!bytes) return null;
    // Another open that shared this read may have held it already.
    const again = this.held.get(sha256);
    if (again) return again.zip;
    const zip = new AdmZip(bytes);
    this.hold(sha256, zip, bytes.length);
    return zip;
  }

  /** A package's bytes from the pod, read once however many ask at once, or null when they are not the package. */
  private read(sha256: string): Promise<Buffer | null> {
    return once(this.reading, sha256, async () => {
      try {
        const r = await (this.opts.fetch ?? globalThis.fetch)(this.urlOf(sha256), { headers: { Accept: 'application/zip' } });
        if (!r.ok) return null;
        const bytes = Buffer.from(await r.arrayBuffer());
        return sha256Of(bytes) === sha256 ? bytes : null;
      } catch { return null; }
    });
  }

  /** Describe a package from its own bytes and keep the description: once however many ask at once. */
  private describeFromPackage(sha256: string): Promise<PackageAbout | null> {
    const describe = this.opts.describePackage;
    if (!describe || !PACKAGE_SHA.test(sha256)) return Promise.resolve(null);
    return once(this.describing, sha256, async () => {
      // Described already: a launch described it while it waited its turn here (Codex, on #551).
      const known = this.abouts.get(sha256);
      if (known) return known;
      // Bytes only for describing are not held: holding them would push out packages being played.
      const held = this.held.get(sha256);
      const bytes = held ? held.zip.toBuffer() : await this.read(sha256);
      let about: PackageAbout | null = null;
      try { about = bytes ? describe(bytes) : null; } catch { about = null; }
      if (about) await this.keepAbout(sha256, about);
      const kept = this.abouts.get(sha256) ?? null;
      if (kept) this.undescribed.delete(sha256);
      else this.undescribed.set(sha256, Date.now() + (this.opts.retryAfterMs ?? 10 * 60_000));
      return kept;
    });
  }

  /** Queue a package to be described in the background, unless it is queued, or was just tried and could not be. */
  private later(sha256: string): void {
    if (!this.opts.describePackage || this.queue.includes(sha256) || this.describing.has(sha256)) return;
    if ((this.undescribed.get(sha256) ?? 0) > Date.now()) return;
    this.queue.push(sha256);
    if (!this.draining) this.drained = this.drain();
  }

  /** Describe the queued packages, one at a time. */
  private async drain(): Promise<void> {
    this.draining = true;
    try {
      for (let sha = this.queue.shift(); sha !== undefined; sha = this.queue.shift()) {
        try { await this.describeFromPackage(sha); } catch { /* described again when next listed */ }
      }
    } finally { this.draining = false; }
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

/** Each item mapped, in order, with at most `limit` in flight at once. */
async function mapLimited<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
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

  /** The fold that takes a package kept here, or an export: POST /agent/content/fold-course with its sha-256. */
  const foldOf = (payload: unknown): Record<string, unknown> => ({
    toolName: 'foxxi.content_fold_course', method: 'POST', target: `${base}/agent/content/fold-course`, payload,
    note: 'Signed as its author-to-be: what it makes is kept on the signer\'s own pod, to resolve, play and learn from. An export launches nothing as it is: fold it, and play what that makes.',
  });

  /**
   * The packages hosted here, each with its course, and one way to launch any of them: the signed
   * cmi5 launch, for the signer, naming the package's course. Read by a learner's page and by an
   * agent alike; nothing in it is anyone's record. It is made from what is kept beside each
   * package, and opens none (Codex, on #550): one with nothing beside it yet is counted as
   * unlisted, and listed once the background has described it. An authoring tool's own export,
   * kept to be folded, is listed apart (`exports`), since it launches nothing.
   */
  app.get('/scorm/packages', async (_req, res) => {
    try {
      const shas = await deps.packages.list();
      const abouts = await mapLimited(shas, 8, sha => deps.packages.aboutOrLater(sha));
      const packages: Array<Record<string, unknown>> = [];
      const exports: Array<Record<string, unknown>> = [];
      let unlisted = 0;
      shas.forEach((sha, i) => {
        const about = abouts[i];
        if (about?.exportOf) {
          exports.push({ packageSha256: sha, href: `${base}/scorm/packages/${sha}`, title: about.title, exportOf: about.exportOf });
          return;
        }
        const course = about ? hostedPackageCourse(base, sha, about) : undefined;
        if (!course?.structure.length) { unlisted++; return; }
        packages.push({
          packageSha256: sha, href: `${base}/scorm/packages/${sha}`,
          course: { id: course.id, title: course.title }, aus: course.structure.map(a => ({ id: a.id, title: a.title })),
        });
      });
      res.json({
        kind: 'hosted-scorm-packages', packages, exports,
        ...(unlisted ? {
          unlisted,
          unlistedWhy: 'kept here with nothing yet describing them: each is read once, in the background, and listed when it has been. One that is neither a package with anything to launch nor a tool\'s own export stays unlisted.',
        } : {}),
        launch: {
          toolName: 'foxxi.cmi5_launch_signed', method: 'POST', target: `${base}/agent/cmi5/launch`, payload: '{ course_id: <a package\'s course.id> }',
          note: 'Signed as the learner: the launch is for the signer, and answers with the launchUrl to open. What the package reports lands in their own record, as experience.',
        },
        fold: foldOf('{ package_sha256: <a package\'s or an export\'s packageSha256> }'),
      });
    } catch (err) { deps.onError(res, err, 'hosted-packages'); }
  });

  app.get(PACKAGE_RECORD, async (req, res) => {
    try {
      const sha = PACKAGE_RECORD.exec(req.path)?.[1] ?? '';
      const course = await deps.courseFor(sha);
      if (!course) {
        // An authoring tool's own export is kept here too, with no course: its record says how to fold it.
        const about = await deps.packages.about(sha);
        if (about?.exportOf) {
          res.json({ kind: 'hosted-project-export', packageSha256: sha, title: about.title, exportOf: about.exportOf, fold: foldOf({ package_sha256: sha }) });
          return;
        }
        res.status(404).json({ error: 'no package with that sha-256 is hosted here' });
        return;
      }
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
