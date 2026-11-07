import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import vm from 'node:vm';
const load = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const source = load('../src/navigation-links.js');
const sandbox = { URL, encodeURIComponent };
vm.createContext(sandbox);
vm.runInContext(source.replaceAll('export ', '') + '\nglobalThis.links = {safeHttpHref,safeNavigationHref};', sandbox);
const { safeHttpHref, safeNavigationHref } = sandbox.links;
const bad = ['javascript:globalThis.__executed++', 'JaVaScRiPt:globalThis.__executed++', 'data:text/html,<script>parent.__executed++</script>', '\u0000javascript:alert(1)', 'java\nscript:alert(1)', '\tjavascript:alert(1)', ' https://example.org/', 'https:\\example.org/', '//example.org/', 'https://user:password@example.org/'];
for (const value of bad) assert.equal(safeHttpHref(value), undefined, value);
assert.equal(safeHttpHref('urn:iep:action:foxxi:test'), undefined);
const url = 'https://example.org/path?q=%2F%20&other=a%25b#Term';
assert.equal(safeHttpHref(url), url);
assert.equal(safeHttpHref('http://example.org/path?q=one&x=two'), 'http://example.org/path?q=one&x=two');
assert.equal(safeHttpHref('HTTPS://example.org/path'), 'https://example.org/path');
assert.equal(safeHttpHref('https://example.org/"<>\''), 'https://example.org/%22%3C%3E%27');
for (const hash of ['#home', '#c-learning-engineering', '#path-one~two', '#agents-act.foxxi.read', '#semantic-cat.model']) assert.equal(safeNavigationHref(hash), hash);
assert.equal(safeNavigationHref('#bad<script>'), undefined);

// Execute the actual handout renderer with hostile data. Identity-bearing JSON-LD
// exports still carry the original IRI; only navigation/HTML rendering is projected.
const iri = 'javascript:parent.__executed++';
const term = { id: 'term', l: '<img src=x onerror=parent.__executed++>', d: '<script>parent.__executed++</script>', a: [], x: '<b>editorial</b>', origin: { kind: 'authored', publisher: '<img onerror=parent.__executed++>' }, ev: [] };
const meta = { scheme: { title: '<svg onload=parent.__executed++>' }, release: 'v0.0.93', license: { holder: 'Owner', name: 'License' } };
const exportsSandbox = { safeHttpHref, META: meta, byId: new Map([['term', term]]), iriOf: () => iri, kindById: new Map(), typeById: new Map(), fieldById: new Map(), directSources: () => [], reuseClass: () => 'open', RIGHTS: {}, attributionLines: () => ['<script>parent.__executed++</script>'], CONCEPT_IDS_EXT: 'https://example.org/concepts', usageStatement: () => ({}), escHtml: value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])), csvCell: String, slugify: String, ttlStr: JSON.stringify };
vm.createContext(exportsSandbox);
vm.runInContext(load('../src/exports.js').replace(/^import .*;\r?\n/gm, '').replaceAll('export ', '') + '\nglobalThis.renderActual = render;', exportsSandbox);
const pack = { id: 'diagnostic', name: '<img src=x onerror=parent.__executed++>', desc: '<script>parent.__executed++</script>', audience: '<svg onload=parent.__executed++>', items: [{ id: 'term', note: '<img onerror=parent.__executed++>' }] };
const html = exportsSandbox.renderActual('html', pack, { notes: true, sources: true });
assert(!html.includes('<script>') && !html.includes('<img') && !html.includes('<svg'));
assert(!html.includes('href="javascript:'));
assert(html.includes('&lt;script&gt;'));
const jsonld = exportsSandbox.renderActual('jsonld', pack);
assert(jsonld.includes(iri), 'Raw exported semantic IRI must remain intact');
if (process.env.NAVIGATION_HANDOUT_OUTPUT) writeFileSync(process.env.NAVIGATION_HANDOUT_OUTPUT, html);
process.stdout.write(JSON.stringify({ unsafeCases: bad.length, fragmentCases: 5, queryPercentEscapesPreserved: true, hostileHandoutEscaped: true, rawJsonLdIriPreserved: true }) + '\n');
