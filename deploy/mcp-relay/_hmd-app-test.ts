// Unit tests for the generic HyperMarkdown MCP-App renderer's SECURITY-CRITICAL
// pure logic. The widget renders UNTRUSTED HMD (note authors control titles,
// labels, links), so escaping, href sanitization, safe Markdown, action
// classification (mutations must never fire without confirmation), and field
// validation must all hold. The logic is the same string embedded in the widget
// HTML — we eval it here so there is one source of truth.
import { HMD_APP_LOGIC_JS } from './hmd-app-logic.js';
import { HMD_APP_HTML } from './hmd-app.js';
import { noteToHyperMarkdown } from './note-view.js';
import { parseHypermediaMarkdown } from '@interego/core';

/* eslint-disable @typescript-eslint/no-implied-eval */
const L = new Function(`${HMD_APP_LOGIC_JS}\nreturn {escapeHtml,sanitizeHref,safeMarkdown,classifyAction,inputModel,validateValue,collectPayload,localName,isRequired,isHmdDoc,shouldRehydrate};`)() as {
  escapeHtml: (s: unknown) => string;
  sanitizeHref: (s: unknown) => string;
  safeMarkdown: (s: unknown) => string;
  classifyAction: (iri: string, method?: string) => 'read' | 'mutate';
  inputModel: (f: Record<string, unknown>) => { kind: string };
  validateValue: (f: Record<string, unknown>, raw: unknown) => string;
  collectPayload: (fields: Array<Record<string, unknown>>, values: Record<string, unknown>) => Record<string, unknown>;
  localName: (iri: string) => string;
  isRequired: (f: Record<string, unknown>) => boolean;
  isHmdDoc: (d: unknown) => boolean;
  shouldRehydrate: (current: unknown, next: unknown) => boolean;
};

let ok = 0, bad = 0;
const check = (n: string, p: boolean, d = '') => { p ? ok++ : bad++; console.log(`  ${p ? 'PASS' : 'FAIL'}  ${n}${d ? '  :: ' + d : ''}`); };
const IEP = 'https://markjspivey-xwisee.github.io/interego/ns/iep#';

// ── escaping ──
check('escapeHtml neutralizes < > & " \'', L.escapeHtml('<b>&"\'') === '&lt;b&gt;&amp;&quot;&#39;');

// ── href sanitization ──
check('sanitizeHref allows https', L.sanitizeHref('https://x.example/a') === 'https://x.example/a');
check('sanitizeHref allows urn/did/mailto', L.sanitizeHref('urn:g:1') === 'urn:g:1' && L.sanitizeHref('did:ethr:0x1') === 'did:ethr:0x1' && L.sanitizeHref('mailto:a@b.c') === 'mailto:a@b.c');
check('sanitizeHref allows relative/fragment', L.sanitizeHref('#control-x') === '#control-x' && L.sanitizeHref('/rel/path') === '/rel/path');
check('sanitizeHref BLOCKS javascript:', L.sanitizeHref('javascript:alert(1)') === '#');
check('sanitizeHref BLOCKS javascript: with case/space', L.sanitizeHref('  JavaScript:alert(1)') === '#');
check('sanitizeHref BLOCKS data: and vbscript:', L.sanitizeHref('data:text/html,<script>') === '#' && L.sanitizeHref('vbscript:msgbox') === '#');
check('sanitizeHref BLOCKS control-char-obfuscated javascript: (tab)', L.sanitizeHref('java\tscript:alert(1)') === '#');
check('sanitizeHref BLOCKS control-char-obfuscated javascript: (newline/CR)', L.sanitizeHref('java\nscript:alert(1)') === '#' && L.sanitizeHref('java\rscript:alert(1)') === '#');
check('sanitizeHref strips leading control chars then blocks the scheme', L.sanitizeHref('\t\n javascript:alert(1)') === '#');
check('sanitizeHref allows a normal https with control-char noise stripped', L.sanitizeHref('https://x.example\t/a') === 'https://x.example/a');

// ── safe Markdown ──
const md1 = L.safeMarkdown('# Title\n\n<script>alert(1)</script>\n\n**bold** and `code`');
check('safeMarkdown escapes raw HTML (no live <script>)', !md1.includes('<script>') && md1.includes('&lt;script&gt;'));
check('safeMarkdown renders heading + bold + code', md1.includes('<h1>Title</h1>') && md1.includes('<strong>bold</strong>') && md1.includes('<code>code</code>'));
const md2 = L.safeMarkdown('[click](javascript:alert(1)) and [ok](https://x.example)');
check('safeMarkdown link with javascript: href → inert (#)', md2.includes('href="#"') && !md2.toLowerCase().includes('href="javascript'));
check('safeMarkdown link with https href preserved', md2.includes('href="https://x.example"'));
check('safeMarkdown link label with markup is escaped', !L.safeMarkdown('[<img src=x onerror=alert(1)>](https://x)').includes('<img'));

// ── action classification — ONLY GET (HTTP safe method) may skip confirmation.
// The author-controlled action NAME is never a skip-confirm signal (a mutation can
// be named askQuestion / verifyClaim), so every non-GET action → 'mutate' → confirm.
check('classify: GET → read (direct fire allowed)', L.classifyAction(`${IEP}ask`, 'GET') === 'read');
check('classify: POST read-y name still confirms (ask/askQuestion/verify → mutate)', L.classifyAction(`${IEP}ask`, 'POST') === 'mutate' && L.classifyAction(`${IEP}askQuestion`, 'POST') === 'mutate' && L.classifyAction(`${IEP}verify`, 'POST') === 'mutate');
check('classify: author-disguised mutation names still confirm (askDelete/verifyAndDelete/checkout/viewDestroy)', L.classifyAction(`${IEP}askDelete`, 'POST') === 'mutate' && L.classifyAction(`${IEP}verifyAndDelete`, 'POST') === 'mutate' && L.classifyAction(`${IEP}checkout`, 'POST') === 'mutate' && L.classifyAction(`${IEP}viewDestroy`, 'POST') === 'mutate');
check('classify: PUT/PATCH/DELETE → mutate', L.classifyAction(`${IEP}x`, 'PUT') === 'mutate' && L.classifyAction(`${IEP}x`, 'PATCH') === 'mutate' && L.classifyAction(`${IEP}x`, 'DELETE') === 'mutate');
check('classify: missing method defaults to mutate (safe)', L.classifyAction(`${IEP}x`, undefined as unknown as string) === 'mutate');
check('classify: acknowledge/proposeCorrection → mutate', L.classifyAction(`${IEP}acknowledge`, 'POST') === 'mutate' && L.classifyAction(`${IEP}proposeCorrection`, 'POST') === 'mutate');

// ── validation ──
const req = { path: `${IEP}q`, name: 'Q', datatype: 'http://www.w3.org/2001/XMLSchema#string', minCount: 1, minLength: 3, maxLength: 10, pattern: '^[a-z]+$' };
check('validate required empty → error', L.validateValue(req, '') !== '');
check('validate minLength → error', L.validateValue(req, 'ab') !== '');
check('validate maxLength → error', L.validateValue(req, 'abcdefghijklmnop') !== '');
check('validate pattern mismatch → error', L.validateValue(req, 'ABC') !== '');
check('validate valid → ok', L.validateValue(req, 'abcd') === '');
check('validate optional empty → ok', L.validateValue({ path: `${IEP}o`, minCount: 0 }, '') === '');
check('validate number datatype rejects non-number', L.validateValue({ path: `${IEP}n`, datatype: 'http://www.w3.org/2001/XMLSchema#integer' }, 'x') !== '');
check('validate hostile pattern does not throw (skipped)', L.validateValue({ path: `${IEP}p`, pattern: '(a+)+$' }, 'aaaa') === '');

// ── payload assembly ──
const pl = L.collectPayload(
  [{ path: `${IEP}question`, datatype: 'http://www.w3.org/2001/XMLSchema#string' }, { path: `${IEP}count`, datatype: 'http://www.w3.org/2001/XMLSchema#integer' }, { path: `${IEP}empty` }],
  { question: 'hi', count: '5', empty: '' },
);
check('collectPayload keys by local name', 'question' in pl && 'count' in pl);
check('collectPayload coerces number', pl['count'] === 5);
check('collectPayload drops empty optional', !('empty' in pl));

// ── HTML integrity ──
check('HMD_APP_HTML is a self-contained doc with the logic + tabs', HMD_APP_HTML.startsWith('<!doctype html>') && HMD_APP_HTML.includes('function safeMarkdown') && HMD_APP_HTML.includes("selectTab(t)") && HMD_APP_HTML.includes('ui/notifications/tool-result'));
// CSP-safety: a strict widget CSP (required by ChatGPT app submission) forbids
// inline event handlers + inline style attributes. Everything must be addEventListener.
check('HMD_APP_HTML: no inline onclick handlers (CSP-safe)', !HMD_APP_HTML.includes('onclick='));
check('HMD_APP_HTML: no inline style="display attribute (CSP-safe)', !HMD_APP_HTML.includes('style="display'));
check('HMD_APP_HTML: tabs wired via addEventListener (not inline)', HMD_APP_HTML.includes("addEventListener('click'"));
// Hydration lifecycle: ChatGPT delivers structuredContent ASYNC via
// openai:set_globals; the widget must listen for it (not only read toolOutput once)
// and render an initial empty state so the mounted frame is never blank.
check('HMD_APP_HTML: hydrates via the async openai:set_globals event', HMD_APP_HTML.includes('openai:set_globals') && HMD_APP_HTML.includes('function hydrate') && HMD_APP_HTML.includes('detail.globals'));
check('HMD_APP_HTML: renders an initial state at boot (never blank)', HMD_APP_HTML.includes('DATA=null; render();') && HMD_APP_HTML.includes('hydrate(readToolOutput())'));
check('HMD_APP_HTML: keeps the MCP Apps tool-result fallback path', HMD_APP_HTML.includes('ui/notifications/tool-result'));
// Re-render guard: render() rebuilds the DOM, so a re-render on an unrelated globals
// event / cloned payload / nested tool result would WIPE in-progress form input +
// the confirm box. shouldRehydrate must gate that (georgio's interaction bug).
{
  const doc = { descriptorUrl: 'https://relay/desc.ttl', hmd: '# x', body: 'x', controls: [] };
  check('isHmdDoc: accepts HMD-shaped, rejects invoke result / null', L.isHmdDoc(doc) && !L.isHmdDoc({ status: 'ok' }) && !L.isHmdDoc(null) && !L.isHmdDoc('x'));
  check('shouldRehydrate: initial (null → HMD doc) = true', L.shouldRehydrate(null, doc) === true);
  check('shouldRehydrate: cloned-identical payload = false (no DOM wipe)', L.shouldRehydrate(doc, { ...doc }) === false);
  check('shouldRehydrate: a nested invoke_affordance result never replaces the doc', L.shouldRehydrate(doc, { status: 'ok', receipt: 1 }) === false);
  check('shouldRehydrate: unrelated globals (no toolOutput handled upstream) — undefined next = false', L.shouldRehydrate(doc, undefined) === false);
  check('shouldRehydrate: a genuinely changed document = true', L.shouldRehydrate(doc, { descriptorUrl: 'https://relay/other.ttl', hmd: '# y', controls: [] }) === true);
}
check('HMD_APP_HTML: set_globals ignores events without a toolOutput (no wipe)', HMD_APP_HTML.includes('g.toolOutput===undefined') && HMD_APP_HTML.includes('shouldRehydrate(DATA,d)'));
check('HMD_APP_HTML references no external origins (self-contained)', !/https?:\/\/(?!x\.example|markjspivey)/.test(HMD_APP_HTML.replace(/https:\/\/www\.w3\.org|http:\/\/www\.w3\.org/g, '')) || !/<script\s+src=|<link\s+href=|@import/i.test(HMD_APP_HTML));

// ── render_hmd → widget structuredContent contract ──
// render_hmd resolves a descriptor, then parses the rendered HMD into the shape
// the widget consumes: controls with action/method + inline SHACL fields the form
// is built from. Prove that end of the pipeline (parse → widget-facing shape).
{
  const descriptorTurtle = `@prefix iep: <${IEP}> .
@prefix hydra: <http://www.w3.org/ns/hydra/core#> .
<https://relay/desc.ttl> a iep:ContextDescriptor ; iep:describes <urn:graph:memory:g> ; iep:affordance <#renderView> .
<#renderView> a iep:Affordance ; iep:action <${IEP}renderView> ; hydra:target <https://relay/render/x> ; hydra:method "GET" .`;
  const payload = `@prefix ieh: <https://markjspivey-xwisee.github.io/interego/ns/harness#> .
@prefix schema: <https://schema.org/> .
@prefix iep: <${IEP}> .
@prefix hmd: <https://markjspivey-xwisee.github.io/interego/ns/hmd#> .
@prefix hydra: <http://www.w3.org/ns/hydra/core#> .
@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
<urn:graph:memory:g> a ieh:AgentMemory ; schema:name "Demo" ; schema:text "A claim." ; hmd:control <#ask> .
<#ask> a hmd:Control, iep:Affordance, hydra:Operation ; iep:action <${IEP}askQuestion> ; hydra:method "POST" ; hydra:expects <#S> .
<#S> a sh:NodeShape ; sh:property [ sh:path <${IEP}question> ; sh:name "Question" ; sh:datatype xsd:string ; sh:minCount 1 ; sh:maxLength 280 ] .`;
  const rendered = noteToHyperMarkdown({ viewUrl: 'https://relay/render/x', authority: 'https://relay/desc.ttl', descriptorTurtle, plaintextTurtle: payload, graphIri: 'urn:graph:memory:g' });
  const doc = parseHypermediaMarkdown(rendered);
  const widget = { descriptorUrl: 'https://relay/desc.ttl', title: doc.title, body: doc.body, controls: doc.controls.map((c) => ({ action: c.action, method: c.method, fields: c.fields })) };
  const askC = widget.controls.find((c) => c.action === `${IEP}askQuestion`);
  check('render_hmd shape: control carries action + method for the widget', !!askC && askC.method === 'POST');
  check('render_hmd shape: control carries inline fields (form is buildable)', !!askC?.fields && askC.fields[0]!.path === `${IEP}question` && askC.fields[0]!.name === 'Question');
  check('render_hmd shape: a POST action requires confirmation (mutate), never direct fire', L.classifyAction(askC!.action, askC!.method) === 'mutate');
  check('render_hmd shape: a required field validates + payload keys by local name', L.validateValue(askC!.fields![0]!, '') !== '' && 'question' in L.collectPayload(askC!.fields! as Array<Record<string, unknown>>, { question: 'hi' }));
}

console.log(`\n${ok}/${ok + bad} hmd-app checks passed`);
process.exit(bad === 0 ? 0 : 1);
