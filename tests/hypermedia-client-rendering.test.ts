/**
 * The hypermedia client (docs/hypermedia-client/index.html) renders whatever a host the
 * user typed in sends back. GitHub Pages serves it from the same origin as
 * docs/client-sign.html, so markup that reached the DOM from a remote document would run
 * next to that page's storage. These tests load the real page in jsdom (the way
 * tests/browser-signing-handoff.test.ts loads client-sign.html), answer its fetches with
 * hostile documents, and check what the page put in the DOM:
 *
 *   - only element and attribute kinds the client itself writes appear, so no script,
 *     event handler, style, frame, link or form target can arrive from remote data;
 *   - every id belongs to the page, and no element carries a `name`, so remote field
 *     names cannot shadow the form's own properties in a browser;
 *   - every followable IRI is http(s), and the page has no href or src at all except
 *     http(s) or a fragment;
 *   - every class is one the stylesheet defines, so remote values cannot restyle a
 *     control as a confirmation or a warning;
 *   - the hostile strings are shown as text, verbatim;
 *   - the Content-Security-Policy hashes match the inline script and style exactly.
 *
 * jsdom does not enforce CSP and does not implement a form's named properties, so those
 * two are checked structurally here, not by observing a browser.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';

const HTML = readFileSync(new URL('../docs/hypermedia-client/index.html', import.meta.url), 'utf8');
const PAGE = 'https://markjspivey-xwisee.github.io/interego/hypermedia-client/';
const HOST = 'https://hostile.example';

// Every payload calls pwn(); the page installs nothing by that name, the test does.
const X = {
  img: '<img src=x onerror="pwn()">',
  script: '<script>pwn()</script>',
  svg: '<svg onload=pwn()><a xlink:href="javascript:pwn()">x</a></svg>',
  dq: '" onmouseover="pwn()" data-x="',
  sq: "' onfocus='pwn()' autofocus x='",
  close: '</textarea></pre></span></code><script>pwn()</script><style>*{display:none}</style>',
  iframe: '<iframe srcdoc="<script>pwn()</script>"></iframe>',
  base: '<base href="https://attacker.example/"><form action="https://attacker.example/"><button>go</button></form>',
};
const ALL = Object.values(X).join(' ');
const BAD_URLS = ['javascript:pwn()', 'JaVaScRiPt:pwn()', ' javascript:pwn()', 'data:text/html,<script>pwn()</script>',
  'vbscript:pwn()', 'javascript&#58;pwn()'];
const QUOTED = `${HOST}/q"onmouseover="pwn()"x="`;

const descriptor = {
  '@context': {
    hydra: 'http://www.w3.org/ns/hydra/core#', iep: 'https://markjspivey-xwisee.github.io/interego/ns/iep#',
    dct: 'http://purl.org/dc/terms/', rdfs: 'http://www.w3.org/2000/01/rdf-schema#', sh: 'http://www.w3.org/ns/shacl#',
    dcat: 'http://www.w3.org/ns/dcat#',
    // Keys and values that collide with Object.prototype members.
    toString: 'constructor', constructor: 'toString', ['__proto__']: 'https://attacker.example/p#',
  },
  '@id': `${HOST}/desc`,
  '@type': ['hydra:Collection', X.img],
  'dct:title': `Title ${X.img}`,
  'dct:description': `${X.script}${X.dq}${X.sq}`,
  'rdfs:seeAlso': [...BAD_URLS, QUOTED, `${HOST}/next`],
  'iep:affordance': [
    ...['markdown', 'html', 'json', 'sparql', 'plain', 'long'].map(kind => ({
      '@id': `${HOST}/desc#read-${kind}`, '@type': 'iep:Affordance', 'iep:action': `urn:read-${kind}`,
      'hydra:method': 'GET', 'hydra:title': `Read ${kind} ${X.img}`, 'hydra:description': X.svg,
      'hydra:target': `${HOST}/body/${kind}`, 'dcat:mediaType': `text/${kind}${X.dq}`,
    })),
    { '@id': `${HOST}/desc#redress`, '@type': 'iep:Affordance', 'iep:action': `urn:redress${X.dq}`,
      'hydra:method': 'ok card active warn', 'hydra:title': X.close, 'hydra:target': QUOTED },
    ...BAD_URLS.map((target, i) => ({ '@id': `${HOST}/desc#bad-${i}`, '@type': 'iep:Affordance',
      'iep:action': `urn:bad-${i}`, 'hydra:method': 'GET', 'hydra:title': `Bad target ${i}`, 'hydra:target': target })),
    { '@id': `${HOST}/desc#write`, '@type': 'iep:Affordance', 'iep:action': 'urn:write', 'hydra:method': 'POST',
      'hydra:title': `Write ${X.sq}`, 'hydra:target': `${HOST}/write`,
      'hydra:expects': { type: 'object', required: [X.dq],
        properties: {
          [X.dq]: { type: 'string', default: X.close, description: X.img },
          pat: { type: 'string', pattern: X.dq, description: X.sq },
          addEventListener: { type: 'string', default: 'x' }, querySelectorAll: { type: 'string' },
          url: { type: 'string', default: 'https://attacker.example/desc' }, invoke: { type: 'string', default: 'urn:write' },
          ['__proto__']: { type: 'object', default: { polluted: true } },
          picked: { type: 'string', enum: [X.img, X.close, X.dq], default: X.close },
          blob: { type: 'object', default: { html: X.script }, description: X.svg },
        } } },
    { '@id': `${HOST}/desc#shape`, '@type': 'iep:Affordance', 'iep:action': 'urn:shape', 'hydra:method': 'GET',
      'hydra:title': 'Shaped read', 'hydra:target': `${HOST}/body/json`, 'hydra:expects': { '@id': `${HOST}/desc#S` } },
  ],
  '@graph': [
    { '@id': `${HOST}/desc#S`, '@type': 'sh:NodeShape', 'sh:property': [
      { 'sh:path': `${HOST}/p${X.dq}`, 'sh:name': `n${X.img}`, 'sh:datatype': 'http://www.w3.org/2001/XMLSchema#string',
        'sh:defaultValue': X.close, 'sh:description': X.script, 'sh:pattern': X.sq },
      { 'sh:path': `${HOST}/choice`, 'sh:name': 'choice', 'sh:in': [X.img, X.close] },
    ] },
  ],
};

// An unbounded `\[([^\]]+)\]`-style scan restarts at every `[` and reads to the end, which is
// quadratic: the renderer this replaced took about 8 s on this input in Node. A linear one takes
// milliseconds, far inside the 3 s budget below.
const longText = '['.repeat(60_000) + '**'.repeat(30_000) + 'https://'.repeat(6_000) + `(${'x'.repeat(60_000)}`;
const markdown = [
  `# Heading ${X.img}`, '', `## ${X.script}`, '',
  `Text with ${X.svg} and ${X.close} and ${X.iframe} and ${X.base}.`, '',
  ...BAD_URLS.map(u => `- [click ${u}](${u})`),
  `- [quoted](${QUOTED})`,
  `- [two words](https://hostile.example/a onmouseover=pwn\`1\` b)`,
  `- [https://hostile.example/inner ${X.dq}](https://hostile.example/outer)`,
  `- **bold ${X.img}** and https://hostile.example/bare"onmouseover="pwn()`, '',
  '```html', `${X.close}${X.script}`, '```', '',
  `<a href="javascript:pwn()">raw link</a> <div style="position:fixed;inset:0">overlay</div>`,
].join('\n');
const bodies: Record<string, { type: string; text: string }> = {
  markdown: { type: 'text/markdown', text: markdown },
  html: { type: 'text/html', text: `<!doctype html><title>t</title>${ALL}<a href="javascript:pwn()">x</a>` },
  json: { type: 'application/json', text: JSON.stringify({ note: ALL, link: QUOTED, bad: BAD_URLS, [X.dq]: X.img }) },
  sparql: { type: 'application/sparql-results+json', text: JSON.stringify({ head: { vars: [X.img, 's'] }, results: { bindings: [
    { [X.img]: { type: 'literal', value: ALL }, s: { type: 'uri', value: QUOTED } },
    { [X.img]: { type: 'uri', value: 'http' + X.dq }, s: { type: 'uri', value: 'javascript:pwn()' } },
  ] } }) },
  plain: { type: 'text/plain', text: `${ALL}\n${BAD_URLS.join('\n')}\n${QUOTED}` },
  long: { type: 'text/markdown', text: longText },
};

const hyperMarkdown = [
  `# HM ${X.img}`, '',
  ':::control hm-read',
  `title: {"html": "${X.script.replace(/"/g, '\\"')}"}`,
  'method: GET',
  `target: ["${HOST}/body/plain"]`,
  `description: ${X.svg}`,
  `mediaType: {"x": 1}`,
  `fields: [{"name": 5, "path": "${HOST}/p"}, {"name": "${X.dq.replace(/"/g, '\\"')}", "defaultValue": {"a": "${X.img.replace(/"/g, '\\"')}"}}]`,
  ':::', '',
  ':::control hm-js',
  'title: js target', 'method: GET', 'target: javascript:pwn()', ':::', '',
  // A key named __proto__ is a key like any other: it does not supply a method the block left out.
  ':::control hm-proto',
  'title: proto key', `target: ${HOST}/body/plain`, '__proto__: {"method": "POST", "destructiveHint": true}', ':::',
].join('\n');

// Two writes side by side. The second one's JSON Schema names types that are Object.prototype
// members; a lookup that reached the prototype used to make its detail view throw, which left
// the first control's form, and its ticked confirmation, on screen for the second control.
const PROTO_TYPES = ['toString', 'constructor', 'valueOf', '__proto__', 'hasOwnProperty'];
const pair = {
  '@context': { hydra: 'http://www.w3.org/ns/hydra/core#', iep: 'https://markjspivey-xwisee.github.io/interego/ns/iep#' },
  '@id': `${HOST}/pair`,
  'iep:affordance': [
    { '@id': `${HOST}/pair#a`, '@type': 'iep:Affordance', 'iep:action': 'urn:a', 'hydra:method': 'POST',
      'hydra:title': 'A write', 'hydra:target': `${HOST}/write-a`,
      'hydra:expects': { type: 'object', properties: { note: { type: 'string', default: 'a' } } } },
    { '@id': `${HOST}/pair#b`, '@type': 'iep:Affordance', 'iep:action': 'urn:b', 'hydra:method': 'DELETE',
      'hydra:title': 'B delete', 'hydra:target': `${HOST}/delete-b`,
      'hydra:expects': { type: 'object', properties: Object.fromEntries(PROTO_TYPES.map(t => [`f_${t}`, { type: t }])) } },
  ],
};
// Remote text the page must not spend super-linear time on. A pattern with overlapping
// alternatives takes about twice as long for each extra character when run against a string it
// does not match, so the page must not run a remote pattern at all. 28 characters took well over
// the 3 s budget before; any more and a regression would hang the run rather than fail it.
const SLOW_PATTERN = '^(a|a)*$';
const SLOW_DEFAULT = 'a'.repeat(28) + 'b';
// A field name and a URL each crafted so that a backtracking pattern retries at every position.
const LONG_NAME = 'rest-param-' + '-'.repeat(150_000) + '\n';
const DOTTED_URL = 'https://hostile.example/a' + '.'.repeat(150_000) + 'x';
const CTX = { hydra: 'http://www.w3.org/ns/hydra/core#', iep: 'https://markjspivey-xwisee.github.io/interego/ns/iep#',
  sh: 'http://www.w3.org/ns/shacl#' };
const slowPattern = {
  '@context': CTX, '@id': `${HOST}/slow-pattern`,
  'iep:affordance': [{ '@id': `${HOST}/slow-pattern#r`, '@type': 'iep:Affordance', 'iep:action': 'urn:r', 'hydra:method': 'GET',
    'hydra:title': 'Slow pattern', 'hydra:target': `${HOST}/body/plain`,
    'hydra:expects': { type: 'object', properties: { q: { type: 'string', pattern: SLOW_PATTERN, default: SLOW_DEFAULT } } } }],
};
const longName = {
  '@context': CTX, '@id': `${HOST}/long-name`,
  'iep:affordance': [{ '@id': `${HOST}/long-name#n`, '@type': 'iep:Affordance', 'iep:action': 'urn:n', 'hydra:method': 'GET',
    'hydra:title': 'Long name', 'hydra:target': `${HOST}/body/plain`, 'hydra:expects': { '@id': `${HOST}/long-name#S` } }],
  '@graph': [{ '@id': `${HOST}/long-name#S`, '@type': 'sh:NodeShape', 'sh:property': [{ 'sh:path': `${HOST}/p`, 'sh:name': LONG_NAME }] }],
};
// Documents served at exact paths on HOST, in addition to /desc, /hm and /body/<kind>.
const DOCS: Record<string, { type: string; text: string }> = {
  '/pair': { type: 'application/ld+json', text: JSON.stringify(pair) },
  '/slow-pattern': { type: 'application/ld+json', text: JSON.stringify(slowPattern) },
  '/long-name': { type: 'application/ld+json', text: JSON.stringify(longName) },
};

function respond(text: string, type: string, status = 200): Response {
  return new Response(text, { status, headers: { 'content-type': type } });
}

interface Loaded { dom: JSDOM; document: Document; calls: Array<{ url: string; method: string }>; pwned: string[]; errors: string[] }

function load(query: string, extra: Record<string, { type: string; text: string }> = {}): Loaded {
  const calls: Loaded['calls'] = []; const pwned: string[] = []; const errors: string[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', e => errors.push(String(e && (e.stack || e.message) || e)));
  const dom = new JSDOM(HTML, { url: PAGE + query, runScripts: 'dangerously', virtualConsole, beforeParse(window) {
    Object.assign(window, {
      pwn: (...args: unknown[]) => { pwned.push(JSON.stringify(args)); },
      fetch: async (input: string, init: RequestInit = {}) => {
        const url = String(input); calls.push({ url, method: String(init.method || 'GET') });
        const u = new URL(url);
        if (u.origin !== HOST) return respond('not here', 'text/plain', 404);
        if (u.pathname === '/desc') return respond(JSON.stringify(descriptor), 'application/ld+json');
        if (u.pathname === '/hm') return respond(hyperMarkdown, 'text/markdown');
        const doc = Object.prototype.hasOwnProperty.call(DOCS, u.pathname) ? DOCS[u.pathname] : undefined;
        if (doc) return respond(doc.text, doc.type);
        const kind = u.pathname.replace('/body/', '');
        const body = extra[kind] || bodies[kind];
        return body ? respond(body.text, body.type) : respond('missing', 'text/plain', 404);
      },
    });
  } });
  return { dom, document: dom.window.document, calls, pwned, errors };
}

const STYLE = (/<style>([\s\S]*?)<\/style>/.exec(HTML) || [])[1] || '';
const STYLE_CLASSES = new Set([...STYLE.matchAll(/\.([a-z][a-z0-9-]*)/g)].map(m => m[1]!));
const PAGE_IDS = new Set(['url', 'loadBtn', 'backBtn', 'proxy', 'status', 'meta', 'list', 'detail', 'invokeForm',
  'confirmUnsafe', 'liveBtn', 'result']);
const TAGS = new Set(['header', 'main', 'aside', 'section', 'h1', 'h2', 'h3', 'p', 'div', 'span', 'strong', 'code', 'br',
  'ul', 'li', 'pre', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'article', 'details', 'summary', 'form', 'label',
  'input', 'textarea', 'select', 'option', 'button', 'script']);
// No `pattern`: the browser would run a remote pattern as a regular expression in its own validation.
const ATTRS = new Set(['class', 'id', 'type', 'placeholder', 'spellcheck', 'disabled', 'required', 'value',
  'selected', 'open', 'data-iri', 'data-rel', 'data-field', 'data-mode', 'aria-label']);

/** Everything a hostile document can try to put in the DOM, checked at once. */
function assertInert(t: Loaded, where: string) {
  const { document } = t;
  const problems: string[] = [];
  const all = [...document.querySelectorAll('*')];
  if (document.scripts.length !== 1) problems.push(`${document.scripts.length} script elements`);
  if (document.head.querySelectorAll('meta').length !== 3) problems.push('meta added to head');
  for (const el of all) {
    const tag = el.localName;
    const inBody = document.body.contains(el) || el === document.body;
    if (inBody && el !== document.body && !TAGS.has(tag)) problems.push(`<${tag}> in body`);
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on')) problems.push(`${tag}[${name}]`);
      if (name === 'style') problems.push(`${tag}[style]`);
      if (['href', 'src', 'srcdoc', 'action', 'formaction', 'xlink:href', 'srcset', 'poster'].includes(name) &&
          !/^(https?:\/\/|#)/.test(attr.value)) problems.push(`${tag}[${name}=${attr.value.slice(0, 40)}]`);
      if (inBody && el !== document.body && !ATTRS.has(name)) problems.push(`${tag}[${name.slice(0, 40)}]`);
    }
    if (el.hasAttribute('name') && inBody) problems.push(`${tag}[name=${el.getAttribute('name')!.slice(0, 40)}]`);
    if (el.id && !PAGE_IDS.has(el.id)) problems.push(`#${el.id.slice(0, 40)}`);
    if (inBody) for (const c of el.classList) if (!STYLE_CLASSES.has(c)) problems.push(`.${c.slice(0, 40)}`);
    const iri = el.getAttribute('data-iri');
    if (iri != null && !/^https?:\/\/[^\s"<>]+$/.test(iri)) problems.push(`data-iri=${iri.slice(0, 60)}`);
  }
  expect([...new Set(problems)], where).toEqual([]);
  expect(t.pwned, where).toEqual([]);
}

const card = (document: Document, text: string) =>
  [...document.querySelectorAll<HTMLElement>('.card')].find(c => c.querySelector('h3')?.textContent?.startsWith(text));
const button = (document: Document, mode: string) =>
  document.querySelector<HTMLButtonElement>(`#invokeForm button[data-mode="${mode}"]`)!;
function click(t: Loaded, el: Element) {
  el.dispatchEvent(new t.dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
}

describe('hypermedia client: hostile remote data stays inert', () => {
  it('renders a hostile JSON-LD descriptor as text in the list and in every control', async () => {
    const t = load(`?url=${encodeURIComponent(HOST + '/desc')}&autoload=1`);
    try {
      const { document } = t;
      await vi.waitFor(() => expect(document.documentElement.dataset['ready'], document.getElementById('status')!.textContent!).toBe('list'));
      assertInert(t, 'list');
      expect(document.querySelector('#meta strong')!.textContent).toBe(`Title ${X.img}`);
      expect(document.getElementById('meta')!.textContent).toContain(`${X.script}${X.dq}${X.sq}`);
      // Only the http(s) seeAlso links become followable, each as the URL parser normalises it,
      // so the quotes in QUOTED are percent-encoded rather than carried into the attribute.
      const see = [...document.querySelectorAll('#meta [data-iri]')].map(e => e.getAttribute('data-iri'));
      expect(see).toEqual([new URL(QUOTED).href, `${HOST}/next`]);
      for (const u of BAD_URLS) expect(document.getElementById('meta')!.textContent).toContain(u);
      expect(card(document, 'Read markdown')!.querySelector('h3')!.textContent).toBe(`Read markdown ${X.img}`);
      // A method that is not a method gets no class of its own choosing.
      const redress = [...document.querySelectorAll('.card')].find(c => c.textContent!.includes('</textarea>'))!;
      expect(redress.querySelector('.badge')!.className).toBe('badge other');

      // Selecting a control re-renders the list, so each card is looked up afresh.
      const count = document.querySelectorAll('.card').length;
      expect(count).toBe(15);
      for (let i = 0; i < count; i++) {
        const c = document.querySelectorAll<HTMLElement>('.card')[i]!;
        const title = c.querySelector('h3')!.textContent!;
        click(t, c);
        expect(document.querySelector('#detail h2')!.textContent, title).toBe(title);
        assertInert(t, `detail of ${title.slice(0, 30)}`);
      }

      click(t, card(document, 'Write')!);
      const fields = [...document.querySelectorAll<HTMLElement>('#invokeForm [data-field]')];
      expect(fields.map(f => f.dataset['field'])).toEqual(expect.arrayContaining([X.dq, 'addEventListener', 'url', 'invoke', '__proto__']));
      expect(fields.find(f => f.dataset['field'] === X.dq)!).toHaveProperty('value', X.close);
      expect(document.getElementById('invokeForm')!.textContent).toContain(X.img);
    } finally { t.dom.window.close(); }
  });

  it.each(Object.keys(bodies))('renders a hostile %s response body as text', async kind => {
    const t = load(`?url=${encodeURIComponent(HOST + '/desc')}&autoload=1`);
    try {
      const { document } = t;
      await vi.waitFor(() => expect(document.documentElement.dataset['ready']).toBe('list'));
      click(t, card(document, `Read ${kind} `)!);
      const started = Date.now();
      click(t, button(document, 'live'));
      await vi.waitFor(() => expect(document.getElementById('result')!.textContent).toMatch(/Response HTTP 200/));
      expect(Date.now() - started, 'rendering time').toBeLessThan(3_000);
      expect(t.calls.map(c => c.url)).toContain(`${HOST}/body/${kind}`);
      assertInert(t, `${kind} body`);
      const shown = document.getElementById('result')!.textContent!;
      if (kind === 'markdown') {
        for (const s of [X.img, X.script, X.svg, X.close, X.iframe, X.base, '<a href="javascript:pwn()">raw link</a>']) expect(shown).toContain(s);
        expect(document.querySelector('#result h1')!.textContent).toBe(`Heading ${X.img}`);
        expect(document.querySelector('#result strong')!.textContent).toBe(`bold ${X.img}`);
        // Link text stays text; only http(s) destinations are followable, and none of the others leak in.
        const iris = [...document.querySelectorAll('#result [data-iri]')].map(e => e.getAttribute('data-iri'));
        expect(iris).toContain('https://hostile.example/outer');
        for (const u of BAD_URLS) expect(shown).toContain(`[click ${u}](${u})`);
      } else if (kind === 'html') {
        expect(document.querySelector('#result iframe')).toBeNull();
        expect(shown).toContain(X.script);
        expect(shown).toContain('<a href="javascript:pwn()">x</a>');
      } else if (kind === 'sparql') {
        expect(document.querySelector('#result th')!.textContent).toBe(X.img);
        expect(shown).toContain(ALL);
      } else if (kind === 'long') {
        expect(shown.length).toBeGreaterThan(1_000);
      } else {
        expect(shown).toContain(X.close);
      }
    } finally { t.dom.window.close(); }
  });

  it('renders HyperMarkdown control blocks whose values are not strings', async () => {
    const t = load(`?url=${encodeURIComponent(HOST + '/hm')}&autoload=1`);
    try {
      const { document } = t;
      await vi.waitFor(() => expect(document.documentElement.dataset['ready'], document.getElementById('status')!.textContent!).toBe('list'));
      assertInert(t, 'hypermarkdown list');
      expect(document.querySelector('#meta strong')!.textContent).toBe(`HM ${X.img}`);
      const count = document.querySelectorAll('.card').length;
      expect(count).toBe(3);
      for (let i = 0; i < count; i++) { click(t, document.querySelectorAll('.card')[i]!); assertInert(t, 'hypermarkdown detail'); }
      expect(document.getElementById('list')!.textContent).toContain(X.script);
      expect(card(document, 'proto key')!.querySelector('.badge')!.className).toBe('badge get');
      expect(t.errors).toEqual([]);
    } finally { t.dom.window.close(); }
  });
});

describe('hypermedia client: requests', () => {
  it('keeps an unsafe control a dry run until the write is confirmed', async () => {
    const t = load(`?url=${encodeURIComponent(HOST + '/desc')}&autoload=1`);
    try {
      const { document } = t;
      await vi.waitFor(() => expect(document.documentElement.dataset['ready']).toBe('list'));
      click(t, card(document, 'Write')!);
      expect(button(document, 'live').disabled).toBe(true);
      click(t, button(document, 'dry'));
      await vi.waitFor(() => expect(document.getElementById('result')!.textContent).toContain('Dry run — nothing was sent.'));
      expect(t.calls.filter(c => c.url.startsWith(`${HOST}/write`))).toEqual([]);
      assertInert(t, 'dry run');
      // The planned body carries the remote field names as JSON keys, shown as text.
      expect(document.querySelector('#result pre')!.textContent).toContain(JSON.stringify(X.dq).slice(1, -1).slice(0, 10));
    } finally { t.dom.window.close(); }
  });

  it('does not take a proxy from the page address', async () => {
    const t = load(`?proxy=${encodeURIComponent('https://attacker.example/p')}&url=${encodeURIComponent(HOST + '/desc')}&autoload=1`);
    try {
      const { document } = t;
      await vi.waitFor(() => expect(document.documentElement.dataset['ready']).toBe('list'));
      expect((document.getElementById('proxy') as HTMLInputElement).value).toBe('');
      expect(t.calls.length).toBeGreaterThan(0);
      expect(t.calls.filter(c => !c.url.startsWith(HOST + '/'))).toEqual([]);
    } finally { t.dom.window.close(); }
  });

  it('sends nothing to a URL that is not https', async () => {
    const t = load(`?url=${encodeURIComponent('http://hostile.example/desc')}&autoload=1`);
    try {
      const { document } = t;
      await vi.waitFor(() => expect(document.documentElement.dataset['ready']).toBe('error'));
      expect(document.getElementById('status')!.textContent).toMatch(/https/);
      expect(t.calls).toEqual([]);
    } finally { t.dom.window.close(); }
  });
});

describe('hypermedia client: remote text costs linear time', () => {
  it('does not run a remote pattern, even from an ?invoke= link', async () => {
    const started = Date.now();
    const t = load(`?url=${encodeURIComponent(HOST + '/slow-pattern')}&invoke=urn:r`);
    try {
      const { document } = t;
      await vi.waitFor(() => expect(document.documentElement.dataset['ready'], document.getElementById('status')!.textContent!).toBe('done'), { timeout: 60_000 });
      expect(Date.now() - started, 'link to done').toBeLessThan(3_000);
      // The pattern is shown as text; the server that receives the value is the one that checks it.
      expect(document.querySelector('#invokeForm .hint')!.textContent).toContain(SLOW_PATTERN);
      expect(document.querySelector('[pattern]')).toBeNull();
      expect(t.calls.map(c => c.url)).toContain(`${HOST}/body/plain?q=${SLOW_DEFAULT}`);
      assertInert(t, 'slow pattern');
    } finally { t.dom.window.close(); }
  });

  it('reads a long crafted field name in linear time', async () => {
    const started = Date.now();
    const t = load(`?url=${encodeURIComponent(HOST + '/long-name')}&autoload=1`);
    try {
      const { document } = t;
      await vi.waitFor(() => expect(document.documentElement.dataset['ready'], document.getElementById('status')!.textContent!).toBe('list'), { timeout: 60_000 });
      click(t, card(document, 'Long name')!);
      expect(Date.now() - started, 'load and render').toBeLessThan(3_000);
      // A name with a line break in it is kept whole, as before.
      expect(document.querySelector<HTMLElement>('#invokeForm [data-field]')!.dataset['field']).toBe(LONG_NAME);
    } finally { t.dom.window.close(); }
  });

  it('trims trailing punctuation from a long URL in linear time', async () => {
    const t = load(`?url=${encodeURIComponent(HOST + '/desc')}&autoload=1`, { plain: { type: 'text/plain', text: `see ${DOTTED_URL}.` } });
    try {
      const { document } = t;
      await vi.waitFor(() => expect(document.documentElement.dataset['ready']).toBe('list'));
      click(t, card(document, 'Read plain ')!);
      const started = Date.now();
      click(t, button(document, 'live'));
      await vi.waitFor(() => expect(document.getElementById('result')!.textContent).toMatch(/Response HTTP 200/), { timeout: 60_000 });
      expect(Date.now() - started, 'rendering time').toBeLessThan(3_000);
      // The URL ends in "x", so it is followable whole, and the final "." stays text after it.
      const body = document.querySelector('#result .resp-title + pre')!;
      expect([...body.querySelectorAll('[data-iri]')].map(e => e.getAttribute('data-iri'))).toEqual([DOTTED_URL]);
      expect(body.textContent).toBe(`see ${DOTTED_URL}.`);
    } finally { t.dom.window.close(); }
  });
});

describe('hypermedia client: a confirmation belongs to one control', () => {
  /** Load /pair, open A, tick its confirmation; returns the loaded page. */
  async function confirmA(): Promise<Loaded> {
    const t = load(`?url=${encodeURIComponent(HOST + '/pair')}&autoload=1`);
    const { document } = t;
    await vi.waitFor(() => expect(document.documentElement.dataset['ready'], document.getElementById('status')!.textContent!).toBe('list'));
    click(t, card(document, 'A write')!);
    const box = document.getElementById('confirmUnsafe') as HTMLInputElement;
    box.checked = true;
    box.dispatchEvent(new t.dom.window.Event('change', { bubbles: true }));
    expect(button(document, 'live').disabled).toBe(false);
    return t;
  }
  /** Click every Invoke button on the page and let any request it starts go out. */
  async function pressInvoke(t: Loaded) {
    for (const b of [...t.document.querySelectorAll<HTMLButtonElement>('button[data-mode="live"]')]) click(t, b);
    await new Promise(r => setTimeout(r, 50));
  }

  it('renders a JSON Schema whose type names an Object.prototype member, with a fresh, unticked form', async () => {
    const t = await confirmA();
    try {
      const { document } = t;
      click(t, card(document, 'B delete')!);
      expect(document.querySelector('#detail h2')!.textContent).toBe('B delete');
      const fields = [...document.querySelectorAll<HTMLElement>('#invokeForm [data-field]')].map(f => f.dataset['field']);
      expect(fields).toEqual(PROTO_TYPES.map(p => `f_${p}`));
      // An unknown type is a string field, and its hint says so.
      for (const hint of document.querySelectorAll('#invokeForm .hint')) expect(hint.textContent).toBe('string');
      expect((document.getElementById('confirmUnsafe') as HTMLInputElement).checked).toBe(false);
      expect(button(document, 'live').disabled).toBe(true);
      await pressInvoke(t);
      expect(t.calls.filter(c => c.url.includes('/delete-b'))).toEqual([]);
      expect(t.errors).toEqual([]);
      assertInert(t, 'B detail');
    } finally { t.dom.window.close(); }
  });

  it('shows a warning and no form when a control cannot be rendered, so A\'s confirmation cannot send B', async () => {
    const t = await confirmA();
    try {
      const { document } = t;
      // Any failure while building B's form. The page's function declarations are globals,
      // so the test can make one throw.
      (t.dom.window as unknown as { fieldControl: () => never }).fieldControl = () => { throw new Error('render fault'); };
      click(t, card(document, 'B delete')!);
      expect(document.getElementById('invokeForm')).toBeNull();
      expect(document.getElementById('confirmUnsafe')).toBeNull();
      expect(document.querySelector('#detail .warn')!.textContent).toContain('render fault');
      expect(document.querySelector('.card.active h3')!.textContent).toBe('B delete');
      await pressInvoke(t);
      expect(t.calls.filter(c => c.url.includes('/delete-b') || c.url.includes('/write-a'))).toEqual([]);
      expect(t.errors).toEqual([]);
    } finally { t.dom.window.close(); }
  });
});

describe('hypermedia client: Content-Security-Policy', () => {
  const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(HTML);
  const policy = new Map((meta?.[1] || '').split(';').map(d => d.trim().split(/\s+/)).filter(d => d[0]).map(d => [d[0]!, d.slice(1)]));
  const sha = (text: string) => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;

  it('is declared before any style or script, and is strict', () => {
    expect(meta, 'CSP meta').not.toBeNull();
    expect(HTML.indexOf('http-equiv="Content-Security-Policy"')).toBeLessThan(HTML.indexOf('<style>'));
    expect(policy.get('default-src')).toEqual(["'none'"]);
    expect(policy.get('connect-src')).toEqual(['https:']);
    expect(policy.get('object-src')).toEqual(["'none'"]);
    expect(policy.get('base-uri')).toEqual(["'none'"]);
    expect(policy.get('form-action')).toEqual(["'none'"]);
    for (const d of ['script-src', 'style-src']) {
      expect(policy.get(d), d).toBeDefined();
      for (const source of policy.get(d)!) expect(source, d).toMatch(/^'sha256-[A-Za-z0-9+/]+=*'$/);
    }
  });

  it('names the exact hash of the inline script and the inline style', () => {
    const scripts = [...HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]!);
    const styles = [...HTML.matchAll(/<style>([\s\S]*?)<\/style>/g)].map(m => m[1]!);
    expect(scripts).toHaveLength(1);
    expect(styles).toHaveLength(1);
    expect(policy.get('script-src')).toEqual([sha(scripts[0]!)]);
    expect(policy.get('style-src')).toEqual([sha(styles[0]!)]);
  });

  it('has no inline event handler, style attribute or script URL that the policy would block', () => {
    const markup = HTML.replace(/<script>[\s\S]*?<\/script>/, '').replace(/<style>[\s\S]*?<\/style>/, '');
    expect(markup).not.toMatch(/\son[a-z]+\s*=/i);
    expect(markup).not.toMatch(/javascript:/i);
    // The script writes markup too; a style attribute there would be refused under style-src.
    expect(HTML).not.toMatch(/\sstyle=/);
  });
});
