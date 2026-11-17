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
 *   - every followable IRI is https, and the page has no href or src at all except
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
import { ADDRESS_TEXT_PROBLEM, addressTexts, BODY_TEXTS, CONTAINER_READS, COST_CASES, costDescriptors, countCases, DOCUMENT_REFUSALS, dryRuns, jsonldPlans, jsonldRefusals,
  LINK_CASES, LISTED, sharedDescriptors, sharedMarkdown, UNSAFE_CONTROLS, VALUE_CASES } from './hypermedia-client-fixtures.js';

const HTML = readFileSync(new URL('../docs/hypermedia-client/index.html', import.meta.url), 'utf8');
const PAGE = 'https://markjspivey-xwisee.github.io/interego/hypermedia-client/';
const HOST = 'https://hostile.example';
// A CORS proxy the person typed in. The test's fetch answers for it as a forwarding proxy would.
const PROXY = 'https://myproxy.example';
const PLAIN_HTTP = 'http://plain.example/d3';
// The URL parser leaves an apostrophe unencoded in a path; the page encodes it before it writes the IRI.
const APOSTROPHE = `${HOST}/a'onclick='pwn(21)`;

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
  'rdfs:seeAlso': [...BAD_URLS, QUOTED, APOSTROPHE, PLAIN_HTTP, `${HOST}/next`],
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
  `- [plain link](${PLAIN_HTTP})`,
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
  // A key named __proto__ is a key like any other: it does not supply a method the block left out,
  // so the control has the default method, POST, and not the GET the key names.
  ':::control hm-proto',
  'title: proto key', `target: ${HOST}/body/plain`, '__proto__: {"method": "GET", "readOnlyHint": true}', ':::',
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
// GET controls whose address is not a public https URL. Through a proxy the person runs, often on
// their own machine, each would reach somewhere a web page cannot.
const OFF_LIMITS = ['file:///etc/passwd', 'http://169.254.169.254/latest/meta-data/', 'http://127.0.0.1:8080/admin',
  'gopher://127.0.0.1:6379/_x', 'https://127.0.0.1/admin', 'https://localhost/admin', 'https://api.localhost/x',
  'https://[::1]/x', 'https://[::ffff:127.0.0.1]/x', 'https://[fd00::1]/x', 'https://[fe80::1]/x', 'https://10.1.2.3/x',
  'https://172.16.0.1/x', 'https://192.168.1.1/x', 'https://169.254.169.254/latest/meta-data/', 'https://0.0.0.0/x',
  'https://100.64.0.1/x', 'https://2130706433/x', 'https://0x7f.1/x', 'https://localhost./x'];
const scope = {
  '@context': CTX, '@id': `${HOST}/scope`,
  'iep:affordance': [
    ...OFF_LIMITS.map((template, i) => ({ '@id': `${HOST}/scope#${i}`, '@type': 'iep:Affordance', 'iep:action': `urn:scope-${i}`,
      'hydra:method': 'GET', 'hydra:title': `Scope ${i} target`, 'hydra:template': template })),
    { '@id': `${HOST}/scope#ok`, '@type': 'iep:Affordance', 'iep:action': 'urn:scope-ok', 'hydra:method': 'GET',
      'hydra:title': 'Public read', 'hydra:template': `${HOST}/body/plain` },
  ],
};
// Turtle unless ?format=jsonld is asked for, which this page reads.
const turtleFirst = { '@context': CTX, '@id': `${HOST}/ttl`, 'dct:title': 'From JSON-LD',
  'iep:affordance': [{ '@id': `${HOST}/ttl#r`, '@type': 'iep:Affordance', 'iep:action': 'urn:ttl', 'hydra:method': 'GET',
    'hydra:title': 'Turtle host read', 'hydra:target': `${HOST}/body/plain` }] };
// An enum whose entries are not all strings: an object, a string and a null.
const enumDoc = { '@context': CTX, '@id': `${HOST}/enum`,
  'iep:affordance': [{ '@id': `${HOST}/enum#e`, '@type': 'iep:Affordance', 'iep:action': 'urn:enum', 'hydra:method': 'GET',
    'hydra:title': 'Enum read', 'hydra:target': `${HOST}/body/plain`,
    'hydra:expects': { type: 'object', properties: { b: { enum: [{ x: 1 }, 'plain', null], default: { x: 1 } } } } }] };
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const RDF_NIL = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#nil';
// sh:in written each way JSON-LD allows: a list object, the same in a one-element array with
// @value and @id members, an RDF list of rdf:first / rdf:rest nodes, and a plain array. An empty
// list object restricts nothing, as an empty enum does. These fixtures' fields take one value each,
// so each carries sh:maxCount 1, as Interego's own shapes write one; with no sh:maxCount a property
// takes a list.
const listEnum = { '@context': CTX, '@id': `${HOST}/list-enum`,
  'iep:affordance': [{ '@id': `${HOST}/list-enum#r`, '@type': 'iep:Affordance', 'iep:action': 'urn:list-enum', 'hydra:method': 'GET',
    'hydra:title': 'List enum read', 'hydra:target': `${HOST}/body/plain`, 'hydra:expects': { '@id': `${HOST}/list-enum#S` } }],
  '@graph': [
    { '@id': `${HOST}/list-enum#S`, '@type': 'sh:NodeShape', 'sh:property': [
      { 'sh:maxCount': 1, 'sh:path': 'urn:p:status', 'sh:name': 'status', 'sh:in': { '@list': ['draft', 'published'] } },
      { 'sh:maxCount': 1, 'sh:path': 'urn:p:wrapped', 'sh:name': 'wrapped', 'sh:in': [{ '@list': [{ '@value': 'low' }, { '@id': `${HOST}/high` }] }] },
      { 'sh:maxCount': 1, 'sh:path': 'urn:p:nodes', 'sh:name': 'nodes', 'sh:in': { '@id': '_:l1' } },
      { 'sh:maxCount': 1, 'sh:path': 'urn:p:plain', 'sh:name': 'plain', 'sh:in': ['red', 'blue'] },
      { 'sh:maxCount': 1, 'sh:path': 'urn:p:empty', 'sh:name': 'empty', 'sh:in': { '@list': [] } },
    ] },
    { '@id': '_:l1', 'rdf:first': 'one', 'rdf:rest': { '@id': '_:l2' } },
    { '@id': '_:l2', 'rdf:first': { '@value': 'two' }, 'rdf:rest': { '@id': RDF_NIL } },
  ] };
// A write whose fields are numbers: a required decimal bounded 1 to 10, two integer types, a
// field with a numeric range but no datatype, an unbounded decimal and a double.
const numbers = { '@context': CTX, '@id': `${HOST}/numbers`,
  'iep:affordance': [{ '@id': `${HOST}/numbers#w`, '@type': 'iep:Affordance', 'iep:action': 'urn:numbers', 'hydra:method': 'POST',
    'hydra:title': 'Numeric write', 'hydra:target': `${HOST}/num-target`, 'hydra:expects': { '@id': `${HOST}/numbers#S` } }],
  '@graph': [{ '@id': `${HOST}/numbers#S`, '@type': 'sh:NodeShape', 'sh:property': [
    { 'sh:maxCount': 1, 'sh:path': 'urn:p:amount', 'sh:name': 'amount', 'sh:datatype': `${XSD}decimal`, 'sh:minCount': 1, 'sh:minInclusive': 1, 'sh:maxInclusive': 10 },
    { 'sh:maxCount': 1, 'sh:path': 'urn:p:count', 'sh:name': 'count', 'sh:datatype': `${XSD}integer` },
    { 'sh:maxCount': 1, 'sh:path': 'urn:p:size', 'sh:name': 'size', 'sh:datatype': `${XSD}long` },
    { 'sh:maxCount': 1, 'sh:path': 'urn:p:level', 'sh:name': 'level', 'sh:minInclusive': 1, 'sh:maxInclusive': 5 },
    { 'sh:maxCount': 1, 'sh:path': 'urn:p:price', 'sh:name': 'price', 'sh:datatype': `${XSD}decimal` },
    { 'sh:maxCount': 1, 'sh:path': 'urn:p:ratio', 'sh:name': 'ratio', 'sh:datatype': `${XSD}double` },
  ] }] };
// Number fields whose sh:in entries are written in other ways than the number a person would
// type: typed literals "1.0" and "2.50" for a decimal, "1.0E0" and a JSON 0.5 for a double, "+1"
// and "02" for a long, and JSON 1 and 2.0 for an integer. The same document is served to hmc.py.
const numEnum = { '@context': CTX, '@id': `${HOST}/num-enum`,
  'iep:affordance': [{ '@id': `${HOST}/num-enum#w`, '@type': 'iep:Affordance', 'iep:action': 'urn:num-enum', 'hydra:method': 'POST',
    'hydra:title': 'Numeric enum write', 'hydra:target': `${HOST}/num-target`, 'hydra:expects': { '@id': `${HOST}/num-enum#S` } }],
  '@graph': [{ '@id': `${HOST}/num-enum#S`, '@type': 'sh:NodeShape', 'sh:property': [
    { 'sh:maxCount': 1, 'sh:path': 'urn:p:version', 'sh:name': 'version', 'sh:datatype': `${XSD}decimal`,
      'sh:in': { '@list': [{ '@value': '1.0', '@type': `${XSD}decimal` }, { '@value': '2.50', '@type': `${XSD}decimal` }] } },
    { 'sh:maxCount': 1, 'sh:path': 'urn:p:scale', 'sh:name': 'scale', 'sh:datatype': `${XSD}double`, 'sh:in': [{ '@value': '1.0E0', '@type': `${XSD}double` }, 0.5] },
    { 'sh:maxCount': 1, 'sh:path': 'urn:p:size', 'sh:name': 'size', 'sh:datatype': `${XSD}long`, 'sh:in': { '@list': ['+1', '02'] } },
    { 'sh:maxCount': 1, 'sh:path': 'urn:p:count', 'sh:name': 'count', 'sh:datatype': `${XSD}integer`, 'sh:in': [1, 'COUNT-TWO'] },
  ] }] };
// JSON.stringify writes 2.0 as 2, so the 2.0 is put in the text by hand.
const numEnumText = JSON.stringify(numEnum).replace('"COUNT-TWO"', '2.0');
const RDF_NS = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
// A compacted JSON-LD descriptor, as a JSON-LD processor writes one. Each sh:datatype is a node
// reference holding a compact IRI ({"@id": "xsd:integer"}), or a string under a term the context
// types as "@id" (dt) or "@vocab" (vdt, against an @vocab of XSD). One is a plain string, which
// JSON-LD leaves as the literal "xsd:integer". The three node-level shapes each type a whole body.
const compactTypes = { '@context': [CTX, { xsd: XSD, rdf: RDF_NS, dt: { '@id': 'sh:datatype', '@type': '@id' } },
  { '@vocab': XSD, vdt: { '@id': 'sh:datatype', '@type': '@vocab' } }],
  '@id': `${HOST}/compact-types`,
  'iep:affordance': [
    { '@id': `${HOST}/compact-types#w`, '@type': 'iep:Affordance', 'iep:action': 'urn:compact-types', 'hydra:method': 'POST',
      'hydra:title': 'Compact types write', 'hydra:target': `${HOST}/num-target`, 'hydra:expects': { '@id': `${HOST}/compact-types#S` } },
    ...['integer', 'boolean', 'JSON'].map(kind => ({ '@id': `${HOST}/compact-types#${kind}`, '@type': 'iep:Affordance',
      'iep:action': `urn:${kind}-body`, 'hydra:method': 'POST', 'hydra:title': `Compact ${kind} body`, 'hydra:target': `${HOST}/num-target`,
      'hydra:expects': { '@id': `${HOST}/compact-types#${kind}-shape` } })),
  ],
  '@graph': [
    { '@id': `${HOST}/compact-types#S`, '@type': 'sh:NodeShape', 'sh:property': [
      { 'sh:maxCount': 1, 'sh:path': 'urn:p:count', 'sh:name': 'count', 'sh:datatype': { '@id': 'xsd:integer' } },
      { 'sh:maxCount': 1, 'sh:path': 'urn:p:flag', 'sh:name': 'flag', 'sh:datatype': { '@id': 'xsd:boolean' } },
      { 'sh:maxCount': 1, 'sh:path': 'urn:p:data', 'sh:name': 'data', 'sh:datatype': { '@id': 'rdf:JSON' } },
      { 'sh:maxCount': 1, 'sh:path': 'urn:p:size', 'sh:name': 'size', dt: 'xsd:long' },
      { 'sh:maxCount': 1, 'sh:path': 'urn:p:ratio', 'sh:name': 'ratio', vdt: 'double' },
      { 'sh:maxCount': 1, 'sh:path': 'urn:p:plain', 'sh:name': 'plain', 'sh:datatype': 'xsd:integer' },
    ] },
    ...[['integer', 'xsd:integer'], ['boolean', 'xsd:boolean'], ['JSON', 'rdf:JSON']].map(([kind, dt]) => ({
      '@id': `${HOST}/compact-types#${kind}-shape`, '@type': 'sh:NodeShape', 'rdfs:label': `${kind} body`, 'sh:datatype': { '@id': dt } })),
  ] };
// Relative IRIs in a descriptor at a known address: hydra:target as a node reference, and a plain
// string under `target`, a term the kernel's context types as "@id", as it does `action`.
const REL_CTX = { ...CTX, target: { '@id': 'hydra:target', '@type': '@id' }, action: { '@id': 'iep:action', '@type': '@id' } };
const relOp = (id: string, title: string, target: unknown) => ({ '@id': `#${id}`, '@type': 'iep:Affordance',
  'iep:action': `urn:rel-${id}`, 'hydra:method': 'GET', 'hydra:title': title, 'hydra:target': target });
const relDoc = { '@context': REL_CTX, '@id': `${HOST}/rel/sub/desc`, 'iep:affordance': [
  relOp('root', 'Root api', { '@id': '/api' }), relOp('sibling', 'Sibling api', { '@id': 'api' }), relOp('parent', 'Parent x', { '@id': '../x' }),
  { '@id': '#coerced', '@type': 'iep:Affordance', action: 'iep:relCoerced', 'hydra:method': 'GET', 'hydra:title': 'Coerced target', target: 'coerced?a=1' },
  relOp('bare', 'Bare fragment', { '@id': '#frag' }), relOp('doc', 'Document fragment', { '@id': `${HOST}/rel/sub/desc#frag2` }),
] };
const relBase = { '@context': [REL_CTX, { '@base': 'https://other.example/base/' }], '@id': `${HOST}/rel-base`,
  'iep:affordance': [relOp('based', 'Based api', { '@id': 'api' }), relOp('based-frag', 'Based fragment', { '@id': '#frag' })] };
const relHttp = { '@context': [REL_CTX, { '@base': 'http://plain.example/' }], '@id': `${HOST}/rel-http`,
  'iep:affordance': [relOp('plain', 'Plain http', { '@id': '/api' })] };
// Documents served at exact paths on HOST, in addition to /desc, /hm and /body/<kind>.
const DOCS: Record<string, { type: string; text: string }> = {
  '/pair': { type: 'application/ld+json', text: JSON.stringify(pair) },
  '/slow-pattern': { type: 'application/ld+json', text: JSON.stringify(slowPattern) },
  '/long-name': { type: 'application/ld+json', text: JSON.stringify(longName) },
  '/scope': { type: 'application/ld+json', text: JSON.stringify(scope) },
  '/enum': { type: 'application/ld+json', text: JSON.stringify(enumDoc) },
  '/list-enum': { type: 'application/ld+json', text: JSON.stringify(listEnum) },
  '/numbers': { type: 'application/ld+json', text: JSON.stringify(numbers) },
  '/num-target': { type: 'application/json', text: '{"ok":true}' },
  '/num-enum': { type: 'application/ld+json', text: numEnumText },
  '/compact-types': { type: 'application/ld+json', text: JSON.stringify(compactTypes) },
  '/rel/sub/desc': { type: 'application/ld+json', text: JSON.stringify(relDoc) },
  '/rel-base': { type: 'application/ld+json', text: JSON.stringify(relBase) },
  '/rel-http': { type: 'application/ld+json', text: JSON.stringify(relHttp) },
  '/api': { type: 'text/plain', text: 'fine' },
  // A nested object lifted onto its node by @nest, holding a "__proto__" key. JSON text, because an
  // object literal's __proto__ key would set its prototype here.
  '/proto-nest': { type: 'application/ld+json', text: JSON.stringify({ '@context': { ...CTX, annotations: '@nest' }, '@id': `${HOST}/proto-nest`,
    'iep:affordance': [{ '@id': '#p', '@type': 'iep:Affordance', 'iep:action': 'urn:proto-nest', 'hydra:method': 'GET',
      'hydra:title': 'Proto nest', 'hydra:target': `${HOST}/body/plain`, annotations: { PROTO: { fields: [{ name: 'injected' }], action: 'urn:other' } } }] })
    .replace('"PROTO"', '"__proto__"') },
};
// The documents hmc.py's test reads too, served from HOST.
const SHARED = sharedDescriptors(HOST);
const SHARED_MD = sharedMarkdown(HOST);
// Large documents whose shape once cost a product of two of their sizes, built once.
const COST = costDescriptors(HOST);
// Documents whose fetch lands somewhere else after redirects: fetch reports that address as the
// response's url. /dir lands at /dir/, the usual trailing-slash redirect; /short at another host and
// path, as a w3id or purl name does.
const relDir = { '@context': CTX, '@id': '', 'iep:affordance': [
  { '@id': '#list', '@type': 'iep:Affordance', 'iep:action': { '@id': 'iep:list' }, 'hydra:method': 'GET', 'hydra:title': 'List items',
    'hydra:target': { '@id': 'items' } },
  { '@id': '#create', '@type': 'iep:Affordance', 'iep:action': { '@id': 'iep:create' }, 'hydra:method': 'POST', 'hydra:title': 'Create item',
    'hydra:target': { '@id': 'items' }, 'hydra:expects': { type: 'object', properties: { name: { type: 'string' } } } }] };
const LANDED: Record<string, { landed: string; text: string }> = {
  '/dir': { landed: `${HOST}/dir/`, text: JSON.stringify(relDir) },
  '/short': { landed: 'https://data.example/real/desc', text: JSON.stringify({ '@context': CTX, '@id': '', 'iep:affordance': [
    { '@id': '#w', '@type': 'iep:Affordance', 'iep:action': { '@id': 'urn:write' }, 'hydra:method': 'POST', 'hydra:title': 'Write',
      'hydra:target': { '@id': 'api' }, 'hydra:expects': { type: 'object', properties: { note: { type: 'string' } } } }] }) },
};

function respond(text: string, type: string, status = 200): Response {
  return new Response(text, { status, headers: { 'content-type': type } });
}

interface Loaded { dom: JSDOM; document: Document; calls: Array<{ url: string; method: string }>; sent: Array<{ url: string; body: string }>;
  pwned: string[]; errors: string[] }

function load(query: string, extra: Record<string, { type: string; text: string }> = {}): Loaded {
  const calls: Loaded['calls'] = []; const sent: Loaded['sent'] = []; const pwned: string[] = []; const errors: string[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', e => errors.push(String(e && (e.stack || e.message) || e)));
  const dom = new JSDOM(HTML, { url: PAGE + query, runScripts: 'dangerously', virtualConsole, beforeParse(window) {
    Object.assign(window, {
      pwn: (...args: unknown[]) => { pwned.push(JSON.stringify(args)); },
      fetch: async (input: string, init: RequestInit = {}) => {
        const url = String(input); calls.push({ url, method: String(init.method || 'GET') });
        if (init.body != null) sent.push({ url, body: String(init.body) });
        const asked = new URL(url);
        const u = asked.origin === PROXY ? new URL(asked.searchParams.get('url') || 'about:blank') : asked;
        if (u.origin !== HOST) return respond('not here', 'text/plain', 404);
        if (u.pathname === '/desc') return respond(JSON.stringify(descriptor), 'application/ld+json');
        if (u.pathname === '/hm') return respond(hyperMarkdown, 'text/markdown');
        if (u.pathname === '/ttl') {
          return u.searchParams.get('format') === 'jsonld' ? respond(JSON.stringify(turtleFirst), 'application/ld+json')
            : respond('@prefix dct: <http://purl.org/dc/terms/> .\n<> dct:title "From Turtle" .\n', 'text/turtle');
        }
        const doc = Object.prototype.hasOwnProperty.call(DOCS, u.pathname) ? DOCS[u.pathname] : undefined;
        if (doc) return respond(doc.text, doc.type);
        if (Object.prototype.hasOwnProperty.call(SHARED, u.pathname)) return respond(SHARED[u.pathname]!, 'application/ld+json');
        if (Object.prototype.hasOwnProperty.call(SHARED_MD, u.pathname)) return respond(SHARED_MD[u.pathname]!, 'text/markdown');
        if (Object.prototype.hasOwnProperty.call(COST, u.pathname)) return respond(COST[u.pathname]!, 'application/ld+json');
        const moved = Object.prototype.hasOwnProperty.call(LANDED, u.pathname) ? LANDED[u.pathname] : undefined;
        if (moved) return Object.defineProperty(respond(moved.text, 'application/ld+json'), 'url', { value: moved.landed });
        const kind = u.pathname.replace('/body/', '');
        const body = extra[kind] || bodies[kind];
        return body ? respond(body.text, body.type) : respond('missing', 'text/plain', 404);
      },
    });
  } });
  return { dom, document: dom.window.document, calls, sent, pwned, errors };
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
  'selected', 'multiple', 'open', 'data-iri', 'data-rel', 'data-field', 'data-mode', 'aria-label']);

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
    if (iri != null && !/^https:\/\/[^\s"'<>]+$/.test(iri)) problems.push(`data-iri=${iri.slice(0, 60)}`);
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
/** Each problem a refused invoke lists, whole. */
const listed = (document: Document) => [...document.querySelectorAll('#result li')].map(li => li.textContent);

describe('hypermedia client: hostile remote data stays inert', () => {
  it('renders a hostile JSON-LD descriptor as text in the list and in every control', async () => {
    const t = load(`?url=${encodeURIComponent(HOST + '/desc')}&autoload=1`);
    try {
      const { document } = t;
      await vi.waitFor(() => expect(document.documentElement.dataset['ready'], document.getElementById('status')!.textContent!).toBe('list'));
      assertInert(t, 'list');
      expect(document.querySelector('#meta strong')!.textContent).toBe(`Title ${X.img}`);
      expect(document.getElementById('meta')!.textContent).toContain(`${X.script}${X.dq}${X.sq}`);
      // Only the https seeAlso links become followable, each as the URL parser normalises it,
      // so the quotes in QUOTED are percent-encoded rather than carried into the attribute.
      const see = [...document.querySelectorAll('#meta [data-iri]')].map(e => e.getAttribute('data-iri'));
      expect(see).toEqual([new URL(QUOTED).href, `${HOST}/a%27onclick=%27pwn(21)`, `${HOST}/next`]);
      // An http IRI is shown, not offered as a link the page would then refuse to fetch.
      for (const u of [...BAD_URLS, PLAIN_HTTP]) expect(document.getElementById('meta')!.textContent).toContain(u);
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
        // Link text stays text; only https destinations are followable, and none of the others leak in.
        const iris = [...document.querySelectorAll('#result [data-iri]')].map(e => e.getAttribute('data-iri'));
        expect(iris).toContain('https://hostile.example/outer');
        for (const u of BAD_URLS) expect(shown).toContain(`[click ${u}](${u})`);
        // A link to an http address is not followable, so its address stays in view as text.
        expect(shown).toContain(`[plain link](${PLAIN_HTTP})`);
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
      expect(card(document, 'proto key')!.querySelector('.badge')!.className).toBe('badge post');
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

  /** Fill the proxy field and load `path` from HOST through it, as a person would. */
  async function loadViaProxy(path: string): Promise<Loaded> {
    const t = load('');
    const { document } = t;
    (document.getElementById('proxy') as HTMLInputElement).value = PROXY + '/';
    (document.getElementById('url') as HTMLInputElement).value = HOST + path;
    click(t, document.getElementById('loadBtn')!);
    await vi.waitFor(() => expect(document.documentElement.dataset['ready'], document.getElementById('status')!.textContent!).toBe('list'));
    return t;
  }
  const proxiedTargets = (t: Loaded) => t.calls.filter(c => c.url.startsWith(PROXY + '/')).map(c => new URL(c.url).searchParams.get('url'));

  it('with a proxy, still sends nothing to a URL that is not https', async () => {
    const t = load('');
    try {
      const { document } = t;
      (document.getElementById('proxy') as HTMLInputElement).value = PROXY + '/';
      (document.getElementById('url') as HTMLInputElement).value = 'http://hostile.example/desc';
      click(t, document.getElementById('loadBtn')!);
      await vi.waitFor(() => expect(document.getElementById('status')!.textContent).toMatch(/https/));
      expect(t.calls).toEqual([]);
    } finally { t.dom.window.close(); }
  });

  it('with a proxy, hands it only public https targets, whatever a descriptor names', async () => {
    const t = await loadViaProxy('/scope');
    try {
      const { document } = t;
      expect(proxiedTargets(t)).toEqual([`${HOST}/scope`]);
      for (let i = 0; i < OFF_LIMITS.length; i++) {
        click(t, card(document, `Scope ${i} `)!);
        click(t, button(document, 'live'));
        await vi.waitFor(() => expect(document.getElementById('result')!.textContent, OFF_LIMITS[i]).toMatch(/nothing was sent/));
      }
      expect(proxiedTargets(t)).toEqual([`${HOST}/scope`]);
      // A public https target still goes through the proxy.
      click(t, card(document, 'Public read')!);
      click(t, button(document, 'live'));
      await vi.waitFor(() => expect(document.getElementById('result')!.textContent).toMatch(/Response HTTP 200/));
      expect(proxiedTargets(t)).toEqual([`${HOST}/scope`, `${HOST}/body/plain`]);
      expect(t.calls.filter(c => !c.url.startsWith(PROXY + '/'))).toEqual([]);
    } finally { t.dom.window.close(); }
  });

  it('asks a Turtle host for JSON-LD, with or without a proxy', async () => {
    for (const viaProxy of [false, true]) {
      const t = viaProxy ? await loadViaProxy('/ttl?format=turtle') : load(`?url=${encodeURIComponent(HOST + '/ttl?format=turtle')}&autoload=1`);
      try {
        const { document } = t;
        await vi.waitFor(() => expect(document.documentElement.dataset['ready'], document.getElementById('status')!.textContent!).toBe('list'));
        expect(document.querySelector('#meta strong')!.textContent, `proxy: ${viaProxy}`).toBe('From JSON-LD');
      } finally { t.dom.window.close(); }
    }
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

describe('hypermedia client: rendering details', () => {
  it('renders Markdown with CRLF line endings', async () => {
    const crlf = '# Title\r\n\r\n- one\r\n- two\r\n\r\nText\r\nmore';
    const t = load(`?url=${encodeURIComponent(HOST + '/desc')}&autoload=1`, { markdown: { type: 'text/markdown', text: crlf } });
    try {
      const { document } = t;
      await vi.waitFor(() => expect(document.documentElement.dataset['ready']).toBe('list'));
      click(t, card(document, 'Read markdown ')!);
      click(t, button(document, 'live'));
      await vi.waitFor(() => expect(document.getElementById('result')!.textContent).toMatch(/Response HTTP 200/));
      expect(document.querySelector('#result .md h1')!.textContent).toBe('Title');
      expect([...document.querySelectorAll('#result .md li')].map(li => li.textContent)).toEqual(['one', 'two']);
      expect(document.querySelector('#result .md p')!.innerHTML).toBe('Text<br>more');
    } finally { t.dom.window.close(); }
  });

  it('offers and accepts an enum entry that is not a string, as its JSON', async () => {
    const t = load(`?url=${encodeURIComponent(HOST + '/enum')}&autoload=1`);
    try {
      const { document } = t;
      await vi.waitFor(() => expect(document.documentElement.dataset['ready']).toBe('list'));
      click(t, card(document, 'Enum read')!);
      const select = document.querySelector<HTMLSelectElement>('#invokeForm select')!;
      // The blank option stands for "unset"; a null entry adds no second one.
      expect([...select.options].map(o => o.value)).toEqual(['', '{"x":1}', 'plain']);
      expect(select.value).toBe('{"x":1}');
      click(t, button(document, 'dry'));
      await vi.waitFor(() => expect(document.getElementById('result')!.textContent).toContain('Dry run'));
      expect(document.getElementById('result')!.textContent).not.toContain('Validation failed');
    } finally { t.dom.window.close(); }
  });

  it('names the host a control sends to next to its buttons', async () => {
    const t = load(`?url=${encodeURIComponent(HOST + '/desc')}&autoload=1`);
    try {
      const { document } = t;
      await vi.waitFor(() => expect(document.documentElement.dataset['ready']).toBe('list'));
      click(t, card(document, 'Write')!);
      expect(document.querySelector('#invokeForm .actions .dest')!.textContent).toBe('Sends to hostile.example');
      assertInert(t, 'destination');
    } finally { t.dom.window.close(); }
  });

  it('does not run inside another page\'s frame', async () => {
    const calls: string[] = [];
    const outer = new JSDOM('<!doctype html><iframe></iframe>', { url: 'https://framer.example/', runScripts: 'dangerously' });
    try {
      const frame = outer.window.document.querySelector('iframe')!.contentWindow!;
      Object.assign(frame, { fetch: async (input: string) => { calls.push(String(input)); return respond('{}', 'application/json'); } });
      frame.document.open(); frame.document.write(HTML); frame.document.close();
      const document = frame.document;
      expect(document.getElementById('status')!.textContent).toMatch(/does not run inside another page/);
      expect((document.getElementById('loadBtn') as HTMLButtonElement).disabled).toBe(true);
      (document.getElementById('loadBtn') as HTMLButtonElement).click();
      await new Promise(r => setTimeout(r, 50));
      expect(calls).toEqual([]);
    } finally { outer.window.close(); }
  });
});

describe('hypermedia client: SHACL sh:in lists', () => {
  it('offers the members of a JSON-LD list, an RDF list and a plain array, and accepts them', async () => {
    const t = load(`?url=${encodeURIComponent(HOST + '/list-enum')}&autoload=1`);
    try {
      const { document } = t;
      await vi.waitFor(() => expect(document.documentElement.dataset['ready'], document.getElementById('status')!.textContent!).toBe('list'));
      click(t, card(document, 'List enum read')!);
      const options = (name: string) => {
        const select = document.querySelector<HTMLSelectElement>(`#invokeForm select[data-field="${name}"]`);
        return select ? [...select.options].map(o => o.value) : null;
      };
      expect(options('status')).toEqual(['', 'draft', 'published']);
      expect(options('wrapped')).toEqual(['', 'low', `${HOST}/high`]);
      expect(options('nodes')).toEqual(['', 'one', 'two']);
      expect(options('plain')).toEqual(['', 'red', 'blue']);
      // An empty list offers nothing to choose from, so the field is free text.
      expect(options('empty')).toBeNull();
      expect(document.querySelector('#invokeForm input[data-field="empty"]')).not.toBeNull();
      const chosen: Record<string, string> = { status: 'draft', wrapped: 'low', nodes: 'two', plain: 'blue', empty: 'anything' };
      for (const el of document.querySelectorAll<HTMLInputElement>('#invokeForm [data-field]')) el.value = chosen[el.dataset['field']!]!;
      click(t, button(document, 'dry'));
      await vi.waitFor(() => expect(document.getElementById('result')!.textContent).toContain('Dry run'));
      const shown = document.getElementById('result')!.textContent!;
      expect(shown).not.toContain('Validation failed');
      expect(shown).toContain(`${HOST}/body/plain?status=draft&wrapped=low&nodes=two&plain=blue&empty=anything`);
      assertInert(t, 'list enum');
    } finally { t.dom.window.close(); }
  });
});

describe('hypermedia client: numeric fields', () => {
  // [field, input, the error the page reports]. Every number field is a text input, `count` an
  // integer one included: an <input type="number"> would drop text that is not a floating-point
  // number before the page read it, and the field's default would be sent in its place.
  const BAD: Array<[string, string, string]> = [
    ...['abc', 'NaN', 'Infinity', '0x10', '12abc', '1,5'].map(v => ['amount', v, 'amount: not a number'] as [string, string, string]),
    ['amount', '1e999', 'amount: not a finite number'],
    // Only spaces are no number, and are refused as one, not read as an empty field.
    ['amount', '   ', 'amount: not a number'],
    ['amount', '0.5', 'amount: below minInclusive'],
    ['count', 'abc', 'count: not an integer'],
    ['count', '1.5', 'count: not an integer'],
    ['count', ' + 1', 'count: not an integer'],
    ['count', '1e3', 'count: not an integer'],
    ['size', '1.5', 'size: not an integer'],
    ['size', '12abc', 'size: not an integer'],
    ['size', '1e3', 'size: not an integer'],
    // A JSON number cannot carry this integer exactly, so the page does not round it.
    ['size', '9007199254740993', 'size: integer too large to send exactly'],
    ['level', 'abc', 'level: not a number'],
    ['level', '7', 'level: above maxInclusive'],
    // Only a space, tab, CR or LF around a number is not part of it, the set hmc.py strips too.
    ['amount', '\uFEFF5', 'amount: not a number'],
    ['amount', '5\u00A0', 'amount: not a number'],
    // A decimal is exact, so one that a JSON number (a double) would change is refused, as an
    // integer past 2^53 is: the first would pass maxInclusive 10 as 10.
    ['amount', '10.0000000000000001', 'amount: decimal cannot be sent exactly'],
    ['price', '9007199254740993', 'price: decimal cannot be sent exactly'],
    ['price', '0.10000000000000001', 'price: decimal cannot be sent exactly'],
    ['price', '1e-400', 'price: decimal cannot be sent exactly'],
  ];

  it('refuses input that is not a number of the field\'s type, on Dry run and on a confirmed Invoke, and sends nothing', async () => {
    const t = load(`?url=${encodeURIComponent(HOST + '/numbers')}&autoload=1`);
    try {
      const { document } = t;
      await vi.waitFor(() => expect(document.documentElement.dataset['ready'], document.getElementById('status')!.textContent!).toBe('list'));
      click(t, card(document, 'Numeric write')!);
      const box = document.getElementById('confirmUnsafe') as HTMLInputElement;
      box.checked = true;
      box.dispatchEvent(new t.dom.window.Event('change', { bubbles: true }));
      const result = document.getElementById('result')!;
      const fill = (values: Record<string, string>) => {
        for (const el of document.querySelectorAll<HTMLInputElement>('#invokeForm [data-field]')) el.value = values[el.dataset['field']!] ?? '';
      };
      for (const [name, value, message] of BAD) {
        fill({ amount: '2', [name]: value });
        for (const mode of ['dry', 'live']) {
          result.innerHTML = '';
          click(t, button(document, mode));
          await vi.waitFor(() => expect(result.textContent, `${name}=${JSON.stringify(value)} (${mode})`).toContain('Validation failed'));
          expect(result.textContent, `${name}=${JSON.stringify(value)} (${mode})`).toContain(message);
        }
      }
      await new Promise(r => setTimeout(r, 50));
      expect(t.calls.filter(c => c.url.startsWith(`${HOST}/num-target`))).toEqual([]);

      // Numbers written as numbers are sent as numbers; surrounding spaces are not part of one. A
      // double is the double nearest its text, the value XSD gives that text.
      fill({ amount: ' 2.5 ', count: '-3', size: '+7', level: '3', price: '\t2.50 ', ratio: '0.10000000000000001' });
      result.innerHTML = '';
      click(t, button(document, 'dry'));
      await vi.waitFor(() => expect(result.textContent).toContain('Dry run — nothing was sent.'));
      const planned = JSON.parse(result.querySelector('pre')!.textContent!) as { body: unknown };
      expect(planned.body).toEqual({ amount: 2.5, count: -3, size: 7, level: '3', price: 2.5, ratio: 0.1 });
      click(t, button(document, 'live'));
      await vi.waitFor(() => expect(result.textContent).toMatch(/Response HTTP 200/));
      expect(t.calls.filter(c => c.url.startsWith(`${HOST}/num-target`))).toEqual([{ url: `${HOST}/num-target`, method: 'POST' }]);
      assertInert(t, 'numeric write');
    } finally { t.dom.window.close(); }
  });

  it('refuses the same from an ?invoke= link, which fills the form without submitting it', async () => {
    const link = `?url=${encodeURIComponent(HOST + '/numbers')}&invoke=urn:numbers&field.amount=abc&field.count=1.5`;
    const t = load(link);
    try {
      const { document } = t;
      await vi.waitFor(() => expect(document.documentElement.dataset['ready'], document.getElementById('status')!.textContent!).toBe('done'));
      const shown = document.getElementById('result')!.textContent!;
      expect(shown).toContain('Validation failed');
      expect(shown).toContain('amount: not a number');
      expect(shown).toContain('count: not an integer');
      expect(t.calls.filter(c => c.url.startsWith(`${HOST}/num-target`))).toEqual([]);
    } finally { t.dom.window.close(); }
  });
});

describe('hypermedia client: numbers in an enum', () => {
  it('offers each entry as it is written and accepts it as the number it is', async () => {
    const t = load(`?url=${encodeURIComponent(HOST + '/num-enum')}&autoload=1`);
    try {
      const { document } = t;
      await vi.waitFor(() => expect(document.documentElement.dataset['ready'], document.getElementById('status')!.textContent!).toBe('list'));
      click(t, card(document, 'Numeric enum write')!);
      const select = (name: string) => document.querySelector<HTMLSelectElement>(`#invokeForm select[data-field="${name}"]`)!;
      const options = (name: string) => [...select(name).options].map(o => o.value);
      expect(options('version')).toEqual(['', '1.0', '2.50']);
      expect(options('scale')).toEqual(['', '1.0E0', '0.5']);
      expect(options('size')).toEqual(['', '+1', '02']);
      expect(options('count')).toEqual(['', '1', '2']);
      const result = document.getElementById('result')!;
      const picks: Array<[Record<string, string>, Record<string, number>]> = [
        [{ version: '1.0', scale: '1.0E0', size: '+1', count: '1' }, { version: 1, scale: 1, size: 1, count: 1 }],
        [{ version: '2.50', scale: '0.5', size: '02', count: '2' }, { version: 2.5, scale: 0.5, size: 2, count: 2 }],
      ];
      for (const [chosen, body] of picks) {
        for (const [name, value] of Object.entries(chosen)) select(name).value = value;
        result.innerHTML = '';
        click(t, button(document, 'dry'));
        await vi.waitFor(() => expect(result.textContent).toMatch(/Dry run — nothing was sent\.|Validation failed/));
        expect(result.textContent, JSON.stringify(chosen)).not.toContain('Validation failed');
        expect((JSON.parse(result.querySelector('pre')!.textContent!) as { body: unknown }).body).toEqual(body);
      }
      expect(t.calls.filter(c => c.url.startsWith(`${HOST}/num-target`))).toEqual([]);
      assertInert(t, 'numeric enum');
    } finally { t.dom.window.close(); }
  });
});

/**
 * Open `path` with an ?invoke= link that dry-runs `rel` with `fields` (a list is a field named once
 * per value), or with `dry` false, one that invokes it as a link can; returns the page and its plan.
 */
async function linkPlan(path: string, rel: string, fields: Record<string, string | string[]>, dry = true) {
  const query = Object.entries(fields).flatMap(([k, v]) => (Array.isArray(v) ? v : [v])
    .map(one => `&field.${encodeURIComponent(k)}=${encodeURIComponent(one)}`)).join('');
  const t = load(`?url=${encodeURIComponent(HOST + path)}&invoke=${encodeURIComponent(rel)}${dry ? '&dry=1' : ''}${query}`);
  const { document } = t;
  await vi.waitFor(() => expect(document.documentElement.dataset['ready'], document.getElementById('status')!.textContent!).toBe('done'));
  const pre = document.querySelector('#result pre');
  const plan = pre ? JSON.parse(pre.textContent!) as { method: string; transport: string; url: string | null; body: unknown; headers: Record<string, string>;
    notes: string[]; mcp: { arguments: { action_iri: string } } | null } : null;
  return { t, shown: document.getElementById('result')!.textContent!, plan };
}

describe('hypermedia client: compact datatype IRIs', () => {
  it('types each field by its datatype when it is a compact IRI, a typed term or a plain xsd: string', async () => {
    const bad = await linkPlan('/compact-types', 'urn:compact-types',
      { count: '1.5', flag: 'maybe', data: 'nope', size: '1.5', ratio: 'abc', plain: '1.5' });
    try {
      expect(bad.shown).toContain('Validation failed');
      for (const message of ['count: not an integer', 'flag must be a boolean', 'data must be JSON', 'size: not an integer',
        'ratio: not a number', 'plain: not an integer']) expect(bad.shown, message).toContain(message);
      assertInert(bad.t, 'compact types');
    } finally { bad.t.dom.window.close(); }
    const good = await linkPlan('/compact-types', 'urn:compact-types',
      { count: '12', flag: 'yes', data: '{"a":[1,2]}', size: '+7', ratio: '0.5', plain: '3' });
    try {
      expect(good.shown).not.toContain('Validation failed');
      expect(good.plan!.body).toEqual({ count: 12, flag: true, data: { a: [1, 2] }, size: 7, ratio: 0.5, plain: 3 });
      expect(good.t.calls.filter(c => c.url.startsWith(`${HOST}/num-target`))).toEqual([]);
    } finally { good.t.dom.window.close(); }
  });

  it.each([
    ['integer', '1.5', 'body: not an integer', '12', '12'],
    ['boolean', 'maybe', 'body must be a boolean', 'yes', 'true'],
    ['JSON', 'nope', 'body must be JSON', '{"a": 1}', '{"a": 1}'],
  ])('types a node-level shape\'s %s body by its compact datatype', async (kind, wrong, message, right, sent) => {
    const bad = await linkPlan('/compact-types', `urn:${kind}-body`, { body: wrong });
    try {
      expect(bad.shown).toContain('Validation failed');
      expect(bad.shown).toContain(message);
    } finally { bad.t.dom.window.close(); }
    const good = await linkPlan('/compact-types', `urn:${kind}-body`, { body: right });
    try {
      expect(good.shown).not.toContain('Validation failed');
      expect(good.plan!.body).toBe(sent);
      if (kind === 'JSON') expect(good.plan!.headers['Content-Type']).toBe('application/json');
    } finally { good.t.dom.window.close(); }
  });
});

describe('hypermedia client: relative targets', () => {
  const transports = (document: Document) => Object.fromEntries([...document.querySelectorAll('.card')].map(c =>
    [c.querySelector('h3')!.textContent!, c.querySelectorAll('.badge')[1]!.textContent!]));
  async function dryPlan(t: Loaded, title: string) {
    const { document } = t;
    click(t, card(document, title)!);
    const result = document.getElementById('result')!;
    click(t, button(document, 'dry'));
    await vi.waitFor(() => expect(result.textContent, title).toContain('Dry run'));
    return JSON.parse(result.querySelector('pre')!.textContent!) as { transport: string; url: string | null; notes: string[] };
  }

  it('resolves a relative hydra:target against the descriptor address, and sends it there', async () => {
    const t = load(`?url=${encodeURIComponent(HOST + '/rel/sub/desc')}&autoload=1`);
    try {
      const { document } = t;
      await vi.waitFor(() => expect(document.documentElement.dataset['ready'], document.getElementById('status')!.textContent!).toBe('list'));
      expect(transports(document)).toEqual({ 'Root api': 'http', 'Sibling api': 'http', 'Parent x': 'http', 'Coerced target': 'http',
        'Bare fragment': 'junction', 'Document fragment': 'junction' });
      const expected: Array<[string, string]> = [['Root api', `${HOST}/api`], ['Sibling api', `${HOST}/rel/sub/api`],
        ['Parent x', `${HOST}/rel/x`], ['Coerced target', `${HOST}/rel/sub/coerced?a=1`]];
      for (const [title, url] of expected) {
        const plan = await dryPlan(t, title);
        expect(plan.transport, title).toBe('http');
        expect(plan.url, title).toBe(url);
        expect(document.querySelector('#invokeForm .dest')!.textContent, title).toBe('Sends to hostile.example');
      }
      // A fragment of this document, written "#frag" or in full, is an action junction, not an address.
      for (const title of ['Bare fragment', 'Document fragment']) {
        const plan = await dryPlan(t, title);
        expect(plan.transport, title).toBe('mcp');
        expect(plan.url, title).toBeNull();
        expect(plan.notes.join(' '), title).toContain('action junction');
      }
      click(t, card(document, 'Root api')!);
      click(t, button(document, 'live'));
      await vi.waitFor(() => expect(document.getElementById('result')!.textContent).toMatch(/Response HTTP 200/));
      expect(t.calls.map(c => c.url)).toContain(`${HOST}/api`);
      assertInert(t, 'relative targets');
    } finally { t.dom.window.close(); }
  });

  it('finds a control by the compact action name a typed term expanded', async () => {
    const { t, plan } = await linkPlan('/rel/sub/desc', 'iep:relCoerced', {});
    try {
      expect(plan).not.toBeNull();
      expect(plan!.transport).toBe('http');
      expect(plan!.url).toBe(`${HOST}/rel/sub/coerced?a=1`);
    } finally { t.dom.window.close(); }
  });

  it('resolves against the context\'s @base when it gives one', async () => {
    const t = load(`?url=${encodeURIComponent(HOST + '/rel-base')}&autoload=1`);
    try {
      const { document } = t;
      await vi.waitFor(() => expect(document.documentElement.dataset['ready'], document.getElementById('status')!.textContent!).toBe('list'));
      expect(transports(document)).toEqual({ 'Based api': 'http', 'Based fragment': 'junction' });
      const plan = await dryPlan(t, 'Based api');
      expect(plan.url).toBe('https://other.example/base/api');
      expect(document.querySelector('#invokeForm .dest')!.textContent).toBe('Sends to other.example');
      expect((await dryPlan(t, 'Based fragment')).transport).toBe('mcp');
    } finally { t.dom.window.close(); }
  });

  it('still sends nothing to a resolved address that is not https', async () => {
    const t = load(`?url=${encodeURIComponent(HOST + '/rel-http')}&autoload=1`);
    try {
      const { document } = t;
      await vi.waitFor(() => expect(document.documentElement.dataset['ready'], document.getElementById('status')!.textContent!).toBe('list'));
      expect((await dryPlan(t, 'Plain http')).url).toBe('http://plain.example/api');
      document.getElementById('result')!.innerHTML = '';
      click(t, button(document, 'live'));
      await vi.waitFor(() => expect(document.getElementById('result')!.textContent).toMatch(/https only; nothing was sent/));
      expect(t.calls.filter(c => !c.url.startsWith(`${HOST}/rel-http`))).toEqual([]);
    } finally { t.dom.window.close(); }
  });
});

/** Load `path` and wait for its list. */
async function loaded(path: string): Promise<Loaded> {
  const t = load(`?url=${encodeURIComponent(HOST + path)}&autoload=1`);
  await vi.waitFor(() => expect(t.document.documentElement.dataset['ready'], t.document.getElementById('status')!.textContent!).toBe('list'));
  return t;
}
const groupTitles = (document: Document, i: number) =>
  [...document.querySelectorAll('.group')[i]!.querySelectorAll('.card h3')].map(h => h.textContent!).sort();
const badges = (document: Document) => Object.fromEntries([...document.querySelectorAll('.card')].map(c =>
  [c.querySelector('h3')!.textContent!, [...c.querySelectorAll('.badge')].map(b => b.textContent).join('/')]));
const formFields = (document: Document) => [...document.querySelectorAll<HTMLElement>('#invokeForm [data-field]')].map(e => e.dataset['field']);

describe('hypermedia client: JSON-LD read as jsonld.js reads it', () => {
  it('treats a GET the document marks destructive as unsafe, however the mark is written, and a link sends nothing', async () => {
    const t = await loaded('/hints');
    try {
      expect(groupTitles(t.document, 0)).toEqual(['Plain read']);
      expect(groupTitles(t.document, 1)).toEqual(['Bare annotations', 'Late prefix', 'Own context', 'Purge cache']);
    } finally { t.dom.window.close(); }
    for (const rel of ['iep:purge', 'iep:late', 'iep:embedded', 'iep:mcp']) {
      const { t: linked, shown } = await linkPlan('/hints', rel, {}, false);
      try {
        expect(shown, rel).toContain('Dry run — nothing was sent.');
        expect(linked.calls.filter(c => c.url.includes('/purge')), rel).toEqual([]);
      } finally { linked.dom.window.close(); }
    }
  });

  it('resolves relative IRIs against the address a redirect landed at', async () => {
    const t = await loaded('/dir');
    try {
      expect(badges(t.document)).toEqual({ 'List items': 'GET/http', 'Create item': 'POST/http' });
    } finally { t.dom.window.close(); }
    const list = await linkPlan('/dir', 'iep:list', {}, false);
    try {
      await vi.waitFor(() => expect(list.t.calls.map(c => c.url)).toContain(`${HOST}/dir/items`));
      expect(list.t.calls.map(c => c.url)).not.toContain(`${HOST}/items`);
    } finally { list.t.dom.window.close(); }
    const elsewhere = await linkPlan('/short', 'urn:write', { note: 'hi' });
    try {
      expect(elsewhere.plan!.url).toBe('https://data.example/real/api');
      expect(elsewhere.t.document.querySelector('#invokeForm .dest')!.textContent).toBe('Sends to data.example');
    } finally { elsewhere.t.dom.window.close(); }
  });

  it.each([
    ['/alias', 'iep:aliasSearch', { q: '5' }, '?q=5'], ['/alias-graph', 'iep:aliasGraph', {}, ''], ['/typeonly', 'iep:typeOnly', { n: '5' }, '?n=5'],
    ['/named-graph', 'iep:named', {}, ''], ['/included', 'iep:included', {}, ''], ['/index-map', 'iep:indexMap', {}, ''], ['/id-map', 'iep:idMap', {}, ''],
  ])('reads %s: keyword aliases, type-only terms, named graphs, @included and container maps', async (path, rel, fields, query) => {
    const { t, plan } = await linkPlan(path, rel, fields);
    try {
      expect(plan, t.document.getElementById('result')!.textContent!).not.toBeNull();
      expect(plan!.transport).toBe('http');
      expect(plan!.url).toBe(`${HOST}/api${query}`);
    } finally { t.dom.window.close(); }
  });

  // A number input drops text that is no number before the page reads it, so the wrong value is a fraction.
  it('types a field by a shape its keyword-aliased or type-only reference names', async () => {
    for (const [path, rel, name] of [['/alias', 'iep:aliasSearch', 'q'], ['/typeonly', 'iep:typeOnly', 'n']]) {
      const { t, shown } = await linkPlan(path!, rel!, { [name!]: '1.5' });
      try { expect(shown, path).toContain(`${name}: not an integer`); } finally { t.dom.window.close(); }
    }
  });

  it('reads a JSON Schema given as a JSON literal value object', async () => {
    const bad = await linkPlan('/json-value', 'iep:jsonValue', { count: '1.5' });
    try {
      expect(bad.shown).toContain("missing required field 'name'");
      expect(bad.shown).toContain('count: not an integer');
    } finally { bad.t.dom.window.close(); }
    const good = await linkPlan('/json-value', 'iep:jsonValue', { name: 'a', count: '2' });
    try { expect(good.plan!.body).toEqual({ name: 'a', count: 2 }); } finally { good.t.dom.window.close(); }
  });

  it('expands an action under "@vocab": "#" and a vocabulary term as the document defines it, not as the page names a property', async () => {
    const cases: Array<[string, string, string]> = [
      ['/vocab-hash', 'publish', `${HOST}/vocab-hash#publish`],
      ['/actions', 'https://vocab.example/actions#search', 'https://vocab.example/actions#search'],
      ['/actions', 'https://vocab.example/actions#comment', 'https://vocab.example/actions#comment'],
      ['/actions', 'urn:example:action:lookup', 'urn:example:action:lookup'],
    ];
    for (const [path, rel, action] of cases) {
      const { t, plan } = await linkPlan(path, rel, {});
      try {
        expect(plan, rel).not.toBeNull();
        expect(plan!.mcp!.arguments.action_iri, rel).toBe(action);
      } finally { t.dom.window.close(); }
    }
  });

  it('takes a flattened document\'s title and links from the node at its address, not the first node', async () => {
    const t = await loaded('/flat');
    try {
      expect(t.document.querySelector('#meta strong')!.textContent).toBe('Glossary catalog');
      expect([...t.document.querySelectorAll('#meta [data-iri]')].map(e => e.getAttribute('data-iri'))).toEqual([`${HOST}/next`]);
    } finally { t.dom.window.close(); }
  });

  it('lifts a nested "__proto__" key as a key, not as the node\'s prototype', async () => {
    const t = await loaded('/proto-nest');
    try {
      expect(badges(t.document)).toEqual({ 'Proto nest': 'GET/http' });
      click(t, card(t.document, 'Proto nest')!);
      expect(formFields(t.document)).toEqual([]);
      expect(t.errors).toEqual([]);
      assertInert(t, 'proto nest');
    } finally { t.dom.window.close(); }
  });

  it('lists operations under hydra:operation, and warns when the class one expects is not described', async () => {
    const t = await loaded('/events');
    try {
      expect(badges(t.document)).toEqual({ 'Create event': 'POST/mcp' });
      click(t, card(t.document, 'Create event')!);
      expect(t.document.querySelector('#detail')!.textContent).toContain('hydra:expects names https://vocab.example/Event, which this document does not describe');
      assertInert(t, 'events');
    } finally { t.dom.window.close(); }
  });

  it('reads a node object under @set, @list or @graph as that node, and unpacks only @index, @id and @type maps', async () => {
    const t = await loaded('/containers');
    try {
      const { document } = t;
      expect(badges(document)).toEqual(Object.fromEntries(CONTAINER_READS.map(([, title]) => [title, 'GET/http'])));
      for (const [rel, title] of CONTAINER_READS) {
        click(t, card(document, title)!);
        // Under @graph an @id map's key is the graph's IRI, and @none is no IRI, so neither names a node.
        const named = document.querySelector('#detail code.code-sm')!.textContent!;
        if (rel) expect(named, title).toBe(rel); else expect(named, title).toMatch(/^_:/);
        const result = document.getElementById('result')!;
        click(t, button(document, 'dry'));
        await vi.waitFor(() => expect(result.textContent, title).toContain('Dry run'));
        expect(JSON.parse(result.querySelector('pre')!.textContent!).url, title).toBe(`${HOST}/api`);
      }
      assertInert(t, 'containers');
    } finally { t.dom.window.close(); }
  });
});

describe('hypermedia client: scoped contexts, map references and repeated keys as jsonld.js reads them', () => {
  it.each(jsonldPlans(HOST))('reads %s: %s is the control jsonld.js gives it', async (path, rel, title, method, url) => {
    const { t, plan, shown } = await linkPlan(path, rel, {});
    try {
      expect(plan, shown).not.toBeNull();
      expect(t.document.querySelector('#detail .detail-title')!.textContent).toBe(title);
      expect([plan!.method, plan!.transport, plan!.url]).toEqual([method, url ? 'http' : 'mcp', url]);
      expect(t.errors).toEqual([]);
    } finally { t.dom.window.close(); }
  });

  it.each(jsonldRefusals(HOST))('lists %s %s as unsafe and refuses it with a problem', async (path, rel, title, method, problem) => {
    const t = await loaded(path);
    try {
      const c = card(t.document, title)!;
      expect(c, title).toBeDefined();
      expect(c.querySelector('.badge')!.textContent).toBe(method);
      expect(groupTitles(t.document, 1)).toContain(title);
      click(t, c);
      expect(t.document.getElementById('invokeForm')).toBeNull();
      expect(t.document.querySelector('#detail .warn')!.textContent).toContain(problem);
    } finally { t.dom.window.close(); }
    // A link that invokes it shows the same warning, builds no form, and sends nothing.
    const linked = load(`?url=${encodeURIComponent(HOST + path)}&invoke=${encodeURIComponent(rel)}`);
    try {
      await vi.waitFor(() => expect(linked.document.documentElement.dataset['ready']).toBe('done'));
      expect(linked.document.getElementById('invokeForm')).toBeNull();
      expect(linked.document.querySelector('#detail .warn')!.textContent).toContain(problem);
      expect(linked.calls.filter(call => !call.url.startsWith(`${HOST}${path}`))).toEqual([]);
    } finally { linked.dom.window.close(); }
  });

  it('reads a JSON Schema with an "@id" under a "type" alias as JSON Schema, numbers and array counts included', async () => {
    const good = await linkPlan('/schema-alias', 'urn:schema:alias', { n: '3', tags: '["a","b"]' });
    try { expect(good.plan!.body).toEqual({ n: 3, tags: ['a', 'b'] }); } finally { good.t.dom.window.close(); }
    const bad = await linkPlan('/schema-alias', 'urn:schema:alias', { n: '9', tags: '[1]' });
    try {
      expect(bad.plan).toBeNull();
      expect(bad.shown).toContain('tags: needs at least 2 values, got 1');
      expect(bad.shown).toContain('n: above maxInclusive 5');
    } finally { bad.t.dom.window.close(); }
  });

  it('passes a percent-encoded triplet through a reserved expansion as it is', async () => {
    const { t, plan } = await linkPlan('/tmpl-pct', 'urn:tmpl:pct', { path: '/x?y=%2F&z=a b' });
    try { expect(plan!.url).toBe(`${HOST}/r/x?y=%2F&z=a%20b`); } finally { t.dom.window.close(); }
  });
});

describe('hypermedia client: every value read, or the control or document refused', () => {
  it('reads every hint value: a GET marked unsafe in any of them is a dry run, and true with false is refused', async () => {
    const t = await loaded('/hint-values');
    try {
      expect(groupTitles(t.document, 0)).toEqual(['Plain hint read']);
      expect(groupTitles(t.document, 1)).toEqual(['Listed hint', 'Merged hint', 'String hint', 'Two hints', 'Typed hint', 'Unreadable hint']);
    } finally { t.dom.window.close(); }
    for (const rel of ['urn:hint:typed', 'urn:hint:string', 'urn:hint:unread']) {
      const { t: linked, shown } = await linkPlan('/hint-values', rel, {}, false);
      try {
        expect(shown, rel).toContain('Dry run — nothing was sent.');
        expect(linked.calls.filter(c => c.url.includes('/purge')), rel).toEqual([]);
      } finally { linked.dom.window.close(); }
    }
  });

  it('reads an input of a shape whose properties and counts are written as @set objects', async () => {
    const { t, plan } = await linkPlan('/set-values', 'urn:set:shape', { q: '5' });
    try { expect(plan!.url).toBe(`${HOST}/api?q=5`); } finally { t.dom.window.close(); }
    const bad = await linkPlan('/set-values', 'urn:set:shape', { q: '1.5' });
    try {
      expect(bad.plan).toBeNull();
      expect(bad.shown).toContain('Validation failed');
    } finally { bad.t.dom.window.close(); }
  });

  it.each(DOCUMENT_REFUSALS)('refuses %s whole, with a problem that names it, and sends nothing', async (path, problem) => {
    const t = load(`?url=${encodeURIComponent(HOST + path)}&autoload=1`);
    try {
      const { document } = t;
      await vi.waitFor(() => expect(document.documentElement.dataset['ready']).toBe('error'));
      expect(document.getElementById('status')!.textContent).toBe(problem);
      expect(document.querySelectorAll('.card')).toHaveLength(0);
      expect(t.calls.filter(c => !c.url.startsWith(HOST + path))).toEqual([]);
    } finally { t.dom.window.close(); }
  });

  it.each([
    ['a short name two controls share', `invoke=remove`, 'More than one control matches remove (urn:a:remove, urn:b:remove); nothing was sent.'],
    ['two controls named in one link', `invoke=urn:a:remove&invoke=urn:b:remove`, 'This link names more than one control to invoke; nothing was sent.'],
  ])('sends nothing for a link that names %s', async (_what, invoke, status) => {
    const t = load(`?url=${encodeURIComponent(HOST + '/same-names')}&${invoke}`);
    try {
      await vi.waitFor(() => expect(t.document.documentElement.dataset['ready']).toBe('done'));
      expect(t.document.getElementById('status')!.textContent).toBe(status);
      expect(t.document.getElementById('invokeForm')).toBeNull();
      expect(t.calls.filter(c => !c.url.startsWith(`${HOST}/same-names`))).toEqual([]);
    } finally { t.dom.window.close(); }
  });

  it('loads nothing from a link that names two descriptors', async () => {
    const t = load(`?url=${encodeURIComponent(HOST + '/same-names')}&url=${encodeURIComponent(HOST + '/hints')}`);
    try {
      await vi.waitFor(() => expect(t.document.documentElement.dataset['ready']).toBe('error'));
      expect(t.document.getElementById('status')!.textContent).toBe('This link names more than one descriptor to load; nothing was loaded.');
      expect(t.calls).toEqual([]);
    } finally { t.dom.window.close(); }
  });

  it('refuses a document that writes NaN, which is not JSON', async () => {
    const t = load(`?url=${encodeURIComponent(HOST + '/not-json')}&autoload=1`);
    try {
      await vi.waitFor(() => expect(t.document.documentElement.dataset['ready']).toBe('error'));
      expect(t.document.querySelectorAll('.card')).toHaveLength(0);
    } finally { t.dom.window.close(); }
  });

  it('refuses a HyperMarkdown block that gives its method twice, shows a title given twice as the last, and reads a hint', async () => {
    const t = await loaded('/hm-repeat');
    try {
      expect(groupTitles(t.document, 0)).toEqual(['Second title']);
      expect(groupTitles(t.document, 1)).toEqual(['Destructive read', 'Repeated method']);
    } finally { t.dom.window.close(); }
    const { t: linked, shown } = await linkPlan('/hm-repeat', 'hm-destructive', {}, false);
    try {
      expect(shown).toContain('Dry run — nothing was sent.');
      expect(linked.calls.filter(c => c.url.includes('/purge'))).toEqual([]);
    } finally { linked.dom.window.close(); }
  });
});

describe('hypermedia client: one reading of each document, as hmc.py reads it', () => {
  it.each(LISTED)('lists every control %s gives, nested, blank or typed as something else too, and no others', async (path, titles) => {
    const t = await loaded(path);
    try {
      expect([...t.document.querySelectorAll('.card h3')].map(h => h.textContent!).sort()).toEqual([...titles]);
    } finally { t.dom.window.close(); }
  });

  it.each(UNSAFE_CONTROLS)('lists %s %s as unsafe, and a link sends nothing', async (path, rel, title, method) => {
    const t = await loaded(path);
    try {
      const c = card(t.document, title)!;
      expect(c, title).toBeDefined();
      expect(c.querySelector('.badge')!.textContent).toBe(method);
      expect(groupTitles(t.document, 1)).toContain(title);
    } finally { t.dom.window.close(); }
    if (!rel) return;
    const { t: linked, shown } = await linkPlan(path, rel, {}, false);
    try {
      expect(shown, rel).toContain('Dry run — nothing was sent.');
      expect(linked.calls.filter(call => !call.url.startsWith(`${HOST}${path}`)), rel).toEqual([]);
    } finally { linked.dom.window.close(); }
  });

  it.each(dryRuns(HOST))('dry-runs %s %s to the same request, or stops at the same error, as hmc.py', async (path, rel, fields, outcome) => {
    const { t, plan, shown } = await linkPlan(path, rel, fields);
    try {
      if ('error' in outcome) {
        expect(plan, shown).toBeNull();
        expect(listed(t.document), shown).toContain(outcome.error);
      } else {
        expect(plan, shown).not.toBeNull();
        expect([plan!.url, plan!.body]).toEqual([outcome.url, outcome.body]);
      }
    } finally { t.dom.window.close(); }
  });
});

describe('hypermedia client: a link\'s values, checked as given', () => {
  it.each(LINK_CASES)('plans %s %s from a link giving %j as hmc.py plans it: case %#', async (path, rel, fields, outcome) => {
    const { t, plan, shown } = await linkPlan(path, rel, fields);
    try {
      if ('error' in outcome) {
        expect(plan, shown).toBeNull();
        expect(listed(t.document), shown).toContain(outcome.error);
      } else {
        expect(plan, shown).not.toBeNull();
        expect(plan!.body).toEqual(outcome.body);
      }
      expect(t.calls.filter(c => c.url.startsWith(`${HOST}/num-target`))).toEqual([]);
    } finally { t.dom.window.close(); }
  });

  it('invokes the form with a link\'s value until the person changes that input, and shows a line break in a text area', async () => {
    const { t } = await linkPlan('/link-values', 'urn:lv:write', { scope: 'invalid', note: 'a\nb', n: 'abc' });
    try {
      const { document } = t;
      const result = document.getElementById('result')!;
      const input = (name: string) => document.querySelector<HTMLInputElement>(`#invokeForm [data-field="${name}"]`)!;
      expect([input('note').localName, input('note').value]).toEqual(['textarea', 'a\nb']);
      expect([input('n').getAttribute('type'), input('n').value]).toEqual(['text', 'abc']);
      const dryRun = async () => {
        result.innerHTML = '';
        click(t, button(document, 'dry'));
        await vi.waitFor(() => expect(result.textContent).toMatch(/Validation failed|Dry run — nothing was sent\./));
      };
      // Asked again, the form still checks what the link gave, and never sends the default in its place.
      await dryRun();
      expect(listed(document)).toEqual(['scope: must be one of mine, all', 'n: not an integer']);
      // A choice the person makes, and a number they type, are what the form then reads.
      input('scope').value = 'mine';
      input('scope').dispatchEvent(new t.dom.window.Event('change', { bubbles: true }));
      input('n').value = '6';
      input('n').dispatchEvent(new t.dom.window.Event('input', { bubbles: true }));
      await dryRun();
      expect((JSON.parse(result.querySelector('pre')!.textContent!) as { body: unknown }).body)
        .toEqual({ scope: 'mine', picks: ['x'], n: 6, note: 'a\nb', tags: ['a'] });
      expect(t.calls.filter(c => c.url.startsWith(`${HOST}/num-target`))).toEqual([]);
      assertInert(t, 'link values');
    } finally { t.dom.window.close(); }
  });
});

describe('hypermedia client: a link\'s descriptor address, checked as given', () => {
  it.each(addressTexts(HOST))('refuses %j as hmc.py does, rather than load what the address field and the URL parser make of it', async given => {
    const t = load(`?url=${encodeURIComponent(given)}&autoload=1`);
    try {
      await vi.waitFor(() => expect(t.document.documentElement.dataset['ready']).toBe('error'));
      expect(t.document.getElementById('status')!.textContent).toBe(`${ADDRESS_TEXT_PROBLEM}; nothing is sent to ${given}`);
      expect(t.calls).toEqual([]);
    } finally { t.dom.window.close(); }
  });
});

describe('hypermedia client: templates and transport', () => {
  it('resolves a relative IRI template against the base, and applies a prefix modifier', async () => {
    const t = await loaded('/tmpl/desc');
    try {
      expect(badges(t.document)).toEqual({ 'Relative search': 'GET/http', 'Relative items': 'GET/http', 'Prefix shard': 'GET/http' });
    } finally { t.dom.window.close(); }
    const cases: Array<[string, string, Record<string, string>, string]> = [
      ['/tmpl/desc', 'iep:relSearch', { q: 'x' }, `${HOST}/search?q=x`],
      ['/tmpl/desc', 'iep:relItems', { id: '7', limit: '3' }, `${HOST}/tmpl/items/7?limit=3`],
      ['/tmpl/desc', 'iep:prefixShard', { id: 'abcdef' }, `${HOST}/tmpl/shard/ab/abcdef`],
      ['/tmpl-base', 'iep:baseItems', { q: 'x' }, 'https://api.example/v1/items?q=x'],
    ];
    for (const [path, rel, fields, url] of cases) {
      const { t: linked, plan } = await linkPlan(path, rel, fields);
      try { expect(plan!.url, rel).toBe(url); } finally { linked.dom.window.close(); }
    }
    const sent = await linkPlan('/tmpl/desc', 'iep:relSearch', { q: 'x' }, false);
    try {
      await vi.waitFor(() => expect(sent.t.calls.map(c => c.url)).toContain(`${HOST}/search?q=x`));
    } finally { sent.t.dom.window.close(); }
  });

  it('keeps a template mapping with no hydra:property as its own required field', async () => {
    const t = await loaded('/mappings');
    try {
      click(t, card(t.document, 'Delete item')!);
      expect(formFields(t.document)).toEqual(['id', 'force']);
      // The id input is required, so a browser does not submit the form while it is empty.
      expect(t.document.querySelector('#invokeForm [data-field="id"]')!.hasAttribute('required')).toBe(true);
      (t.document.querySelector('#invokeForm [data-field="force"]') as HTMLInputElement).value = 'true';
      const box = t.document.getElementById('confirmUnsafe') as HTMLInputElement;
      box.checked = true;
      box.dispatchEvent(new t.dom.window.Event('change', { bubbles: true }));
      click(t, button(t.document, 'live'));
      await new Promise(r => setTimeout(r, 50));
      expect(t.calls.filter(c => c.url.includes('/items'))).toEqual([]);
    } finally { t.dom.window.close(); }
    const { t: linked, shown } = await linkPlan('/mappings', 'urn:delete-item', { force: 'true' });
    try {
      expect(shown).toContain("missing required field 'id'");
      expect(linked.calls.filter(c => c.url.includes('/items'))).toEqual([]);
    } finally { linked.dom.window.close(); }
    const full = await linkPlan('/mappings', 'urn:delete-item', { id: '7', force: 'true' });
    try { expect(full.plan!.url).toBe(`${HOST}/items/7?force=true`); } finally { full.t.dom.window.close(); }
  });

  it('names a host only when the template fixes it, and sends a template\'s target as a template', async () => {
    const t = await loaded('/dest');
    try {
      click(t, card(t.document, 'Post note')!);
      expect(t.document.querySelector('#invokeForm .dest')!.textContent).toBe('The address comes from a template; the dry run shows it.');
      click(t, card(t.document, 'Fixed host note')!);
      expect(t.document.querySelector('#invokeForm .dest')!.textContent).toBe('Sends to relay.good.example');
    } finally { t.dom.window.close(); }
    const about = await linkPlan('/target-template', 'control-about', { endpoint: `${HOST}/lrs` }, false);
    try {
      await vi.waitFor(() => expect(about.t.calls.map(c => c.url)).toContain(`${HOST}/lrs/about`));
    } finally { about.t.dom.window.close(); }
  });

  it('sends a safe method\'s whole-body field as a parameter and labels a body by its own type', async () => {
    const query = 'SELECT * WHERE { ?s ?p ?o } LIMIT 1';
    const get = await linkPlan('/raw', 'iep:sparqlGet', { query }, false);
    try {
      await vi.waitFor(() => expect(get.t.calls.map(c => c.url).some(u => u.startsWith(`${HOST}/sparql?query=`))).toBe(true));
      const sent = new URL(get.t.calls.find(c => c.url.startsWith(`${HOST}/sparql`))!.url);
      expect(sent.searchParams.get('query')).toBe(query);
    } finally { get.t.dom.window.close(); }
    const post = await linkPlan('/raw', 'iep:sparqlPost', { query });
    try {
      expect(post.plan!.headers).toEqual({ Accept: 'application/sparql-results+json', 'Content-Type': 'application/sparql-query' });
      expect(post.plan!.body).toBe(query);
    } finally { post.t.dom.window.close(); }
    const put = await linkPlan('/raw', 'iep:notePut', { body: 'hello' });
    try {
      expect(put.plan!.headers).toEqual({ Accept: 'text/turtle', 'Content-Type': 'text/plain' });
    } finally { put.t.dom.window.close(); }
  });

  it('treats a control with no method as a POST, so a link sends nothing', async () => {
    const t = await loaded('/no-method');
    try { expect(badges(t.document)).toEqual({ 'Publish note': 'POST/http' }); } finally { t.dom.window.close(); }
    const { t: linked, shown } = await linkPlan('/no-method', 'urn:publish-note', {}, false);
    try {
      expect(shown).toContain('Dry run — nothing was sent.');
      expect(linked.calls.filter(c => c.url.includes('/publish'))).toEqual([]);
    } finally { linked.dom.window.close(); }
  });

  it('writes the same URL as hmc.py for a non-ASCII path, a replaced query parameter and number fields', async () => {
    const cases: Array<[string, string, Record<string, string>, string]> = [
      ['/wiki', 'urn:wiki', {}, `${HOST}/wiki/Caf%C3%A9`],
      ['/merge', 'urn:merge', { tag: '["a","b"]', view: 'brief' }, `${HOST}/items?tag=a&tag=b&view=brief`],
      ['/rates', 'urn:rates', { amount: '2', lat: '0.0000001', big: '1e16' }, `${HOST}/rates/2?lat=1e-7&big=10000000000000000`],
    ];
    for (const [path, rel, fields, url] of cases) {
      const { t, plan } = await linkPlan(path, rel, fields);
      try { expect(plan!.url, rel).toBe(url); } finally { t.dom.window.close(); }
    }
  });
});

describe('hypermedia client: forms', () => {
  it('takes a list for a property with no sh:maxCount, checks its count, and sends it as a JSON array', async () => {
    const t = await loaded('/multi');
    try {
      click(t, card(t.document, 'Publish classified')!);
      const field = (name: string) => t.document.querySelector<HTMLTextAreaElement & HTMLSelectElement>(`#invokeForm [data-field="${name}"]`)!;
      expect(field('graph_iri').localName).toBe('input');
      expect(field('conforms_to_shapes').localName).toBe('textarea');
      expect(field('conforms_to_shapes').value).toBe(`${HOST}/shapes`);
      expect(field('tags').localName).toBe('textarea');
      expect(field('levels').multiple).toBe(true);
      expect([...field('levels').options].map(o => o.value)).toEqual(['1', '2', '3']);
      const result = t.document.getElementById('result')!;
      const dry = async () => {
        result.innerHTML = '';
        click(t, button(t.document, 'dry'));
        await vi.waitFor(() => expect(result.textContent).toMatch(/Dry run — nothing was sent\.|Validation failed/));
        return result.textContent!;
      };
      field('graph_iri').value = `${HOST}/g`;
      field('tags').value = 'a';
      expect(await dry()).toContain('tags: needs at least 2 values, got 1');
      field('tags').value = 'a\nb\nc\nd\ne\nf';
      expect(await dry()).toContain('tags: takes at most 5 values, got 6');
      field('tags').value = 'a\n\nb\n';
      for (const o of field('levels').options) o.selected = o.value !== '2';
      expect(await dry()).not.toContain('Validation failed');
      expect((JSON.parse(result.querySelector('pre')!.textContent!) as { body: unknown }).body)
        .toEqual({ graph_iri: `${HOST}/g`, conforms_to_shapes: [`${HOST}/shapes`], tags: ['a', 'b'], levels: [1, 3] });
      expect(t.calls.filter(c => c.url.includes('/num-target'))).toEqual([]);
      assertInert(t, 'list fields');
    } finally { t.dom.window.close(); }
    // A field named twice in a link is a list.
    const linked = await linkPlan('/multi', 'urn:act-publish', { graph_iri: `${HOST}/g`, tags: ['x', 'y'], levels: ['2', '3'] });
    try {
      expect((linked.plan!.body as Record<string, unknown>)).toEqual({ graph_iri: `${HOST}/g`, conforms_to_shapes: [`${HOST}/shapes`], tags: ['x', 'y'], levels: [2, 3] });
    } finally { linked.t.dom.window.close(); }
  });

  it('checks a JSON array\'s count against sh:minCount and sh:maxCount or minItems and maxItems, on Dry run and on a confirmed Invoke', async () => {
    const pages = new Map<string, Loaded>();
    try {
      const open = async (path: string, title: string) => {
        if (!pages.has(path)) pages.set(path, await loaded(path));
        const t = pages.get(path)!;
        click(t, card(t.document, title)!);
        const box = t.document.getElementById('confirmUnsafe') as HTMLInputElement;
        box.checked = true;
        box.dispatchEvent(new t.dom.window.Event('change', { bubbles: true }));
        return t;
      };
      // Opening a control draws its form afresh, so a field not named keeps its default.
      const fill = (t: Loaded, values: Record<string, string>) => {
        for (const [name, value] of Object.entries(values)) {
          t.document.querySelector<HTMLTextAreaElement>(`#invokeForm [data-field="${name}"]`)!.value = value;
        }
      };
      const press = async (t: Loaded, mode: string) => {
        const result = t.document.getElementById('result')!;
        result.innerHTML = '';
        click(t, button(t.document, mode));
        await vi.waitFor(() => expect(result.textContent).toMatch(/Dry run — nothing was sent\.|Validation failed|Response HTTP/));
        return result.textContent!;
      };
      for (const [path, , title, values, message] of countCases(HOST)) {
        const t = await open(path, title);
        fill(t, values);
        for (const mode of ['dry', 'live']) {
          const shown = await press(t, mode);
          expect(shown, `${title} ${JSON.stringify(values)} (${mode})`).toContain('Validation failed');
          expect(shown, `${title} ${JSON.stringify(values)} (${mode})`).toContain(message);
        }
      }
      await new Promise(r => setTimeout(r, 50));
      for (const t of pages.values()) expect(t.calls.filter(c => c.url.startsWith(`${HOST}/num-target`))).toEqual([]);

      // Within its bounds each array is sent as written, and a field that takes one object takes one.
      const t = await open('/counts', 'Node counts');
      fill(t, { members: '[{},{"a":1}]', notes: '[{}]', owner: '{"name":"o"}' });
      expect(await press(t, 'dry')).toContain('Dry run — nothing was sent.');
      expect((JSON.parse(t.document.querySelector('#result pre')!.textContent!) as { body: unknown }).body)
        .toEqual({ members: [{}, { a: 1 }], notes: [{}], owner: { name: 'o' } });
      expect(await press(t, 'live')).toMatch(/Response HTTP 200/);
      expect(t.calls.filter(c => c.url.startsWith(`${HOST}/num-target`))).toEqual([{ url: `${HOST}/num-target`, method: 'POST' }]);
      await open('/counts', 'Item counts');
      fill(t, { tags: '["a","b","c"]', extra: '{"a":[1,2]}' });
      expect(await press(t, 'dry')).toContain('Dry run — nothing was sent.');
      expect((JSON.parse(t.document.querySelector('#result pre')!.textContent!) as { body: unknown }).body)
        .toEqual({ tags: ['a', 'b', 'c'], extra: { a: [1, 2] } });
      assertInert(t, 'counts');
    } finally { for (const t of pages.values()) t.dom.window.close(); }
  });

  it('builds fields from hydra:supportedProperty, by property IRI and by an inline property\'s label', async () => {
    const apidoc = await linkPlan('/apidoc', 'post-comment', { text: 'hello' });
    try {
      expect(formFields(apidoc.t.document)).toEqual(['text', 'author']);
      expect(apidoc.plan!.body).toEqual({ text: 'hello' });
    } finally { apidoc.t.dom.window.close(); }
    const missing = await linkPlan('/apidoc', 'post-comment', {});
    try { expect(missing.shown).toContain("missing required field 'text'"); } finally { missing.t.dom.window.close(); }
    const manifest = await linkPlan('/manifest', 'urn:create-note', { title: 'x', kind: 'memo', priority: '9' });
    try {
      expect(formFields(manifest.t.document)).toEqual(['title', 'priority', 'kind']);
      expect(manifest.shown).toContain('priority: above maxInclusive 5');
    } finally { manifest.t.dom.window.close(); }
  });

  it('matches a template mapping\'s compact hydra:property to the shape\'s path, so one field carries the shape\'s limits', async () => {
    const { t, shown } = await linkPlan('/mapprop', 'iep:find', { text: 'abcdefgh' });
    try {
      expect(formFields(t.document)).toEqual(['text']);
      expect(shown).toContain('text: longer than maxLength 5');
    } finally { t.dom.window.close(); }
  });

  it('names a field from a relative path with non-ASCII characters as written, as hmc.py does', async () => {
    const { t, plan } = await linkPlan('/fiche', 'urn:fiche', { 'prénom': 'Ada', 'âge': '36' });
    try {
      expect(formFields(t.document)).toEqual(['prénom', 'âge']);
      expect(plan!.body).toEqual({ 'prénom': 'Ada', 'âge': 36 });
    } finally { t.dom.window.close(); }
  });

  it('refuses a control with two fields of one name, and a link field no input has', async () => {
    const t = await loaded('/dup');
    try {
      click(t, card(t.document, 'Two descriptions')!);
      expect(t.document.getElementById('invokeForm')).toBeNull();
      expect(t.document.querySelector('#detail .warn')!.textContent).toContain("two input fields are both named 'description'");
    } finally { t.dom.window.close(); }
    const unknown = await linkPlan('/bool-enum', 'urn:accept', { agree: 'true', nope: '1' });
    try {
      expect(unknown.shown).toContain("no input field is named 'nope'");
      expect(unknown.plan).toBeNull();
    } finally { unknown.t.dom.window.close(); }
  });

  it('accepts a JSON boolean or object enum entry as its JSON text, and reads a count facet written 1.0', async () => {
    const { t, plan } = await linkPlan('/bool-enum', 'urn:accept', { agree: 'true', mode: '{"a":1}' });
    try { expect(plan!.body).toEqual({ agree: true, mode: '{"a":1}' }); } finally { t.dom.window.close(); }
    const facets = await linkPlan('/mincount', 'urn:mincount', { a: 'toolong' });
    try { expect(facets.shown).toContain('a: longer than maxLength 3'); } finally { facets.t.dom.window.close(); }
    const empty = await linkPlan('/mincount', 'urn:mincount', {});
    try { expect(empty.shown).toContain("missing required field 'a'"); } finally { empty.t.dom.window.close(); }
  });
});

describe('hypermedia client: values a request can carry, and lengths in code points', () => {
  /** The form of `title` in the document at `path`, with its confirmation checked and `fields` typed in. */
  async function filledForm(path: string, title: string, fields: Record<string, string>) {
    const t = await loaded(path);
    click(t, card(t.document, title)!);
    const box = t.document.getElementById('confirmUnsafe') as HTMLInputElement | null;
    if (box) {
      box.checked = true;
      box.dispatchEvent(new t.dom.window.Event('change', { bubbles: true }));
    }
    for (const [name, value] of Object.entries(fields)) {
      t.document.querySelector<HTMLTextAreaElement>(`#invokeForm [data-field="${name}"]`)!.value = value;
    }
    return t;
  }

  it.each(VALUE_CASES)('reads %s %s (%s) as hmc.py does, by a link and by the form: case %#', async (path, rel, title, fields, outcome) => {
    const link = await linkPlan(path, rel, fields);
    try {
      if ('body' in outcome) {
        expect(link.plan, link.shown).not.toBeNull();
        expect(link.plan!.body).toEqual(outcome.body);
      } else {
        expect(link.plan, link.shown).toBeNull();
        expect(listed(link.t.document), link.shown).toContain(outcome.error);
      }
    } finally { link.t.dom.window.close(); }
    // The form shows the planned body on Dry run, or refuses on Dry run and a confirmed Invoke alike.
    const t = await filledForm(path, title, fields);
    try {
      const result = t.document.getElementById('result')!;
      for (const mode of 'body' in outcome ? ['dry'] : ['dry', 'live']) {
        result.innerHTML = '';
        click(t, button(t.document, mode));
        await vi.waitFor(() => expect(result.textContent).toMatch(/Dry run — nothing was sent\.|Validation failed|Response HTTP/));
        if ('body' in outcome) {
          expect((JSON.parse(t.document.querySelector('#result pre')!.textContent!) as { body: unknown }).body, mode).toEqual(outcome.body);
        } else {
          expect(result.textContent, mode).toContain('Validation failed');
          expect(listed(t.document), mode).toContain(outcome.error);
        }
      }
      await new Promise(r => setTimeout(r, 50));
      expect(t.calls.filter(c => c.url.startsWith(`${HOST}/num-target`))).toEqual([]);
    } finally { t.dom.window.close(); }
  });

  it.each(BODY_TEXTS)('sends %s %s (%s) as the body hmc.py sends, byte for byte: case %#', async (path, _rel, title, fields, body) => {
    const t = await filledForm(path, title, fields);
    try {
      click(t, button(t.document, 'live'));
      // The page has shown the response, so nothing of the invoke is still running when the window closes.
      await vi.waitFor(() => expect(t.document.getElementById('result')!.textContent).toContain('Response HTTP'));
      expect(t.sent.filter(s => s.url === `${HOST}/num-target`).map(s => s.body)).toEqual([body]);
    } finally { t.dom.window.close(); }
  });
});

describe('hypermedia client: the address sent is the address shown', () => {
  /** Dry-run `rel` with an ?invoke= link, then invoke it with another, and return both. */
  async function shownAndSent(rel: string, fields: Record<string, string> = {}) {
    const shown = await linkPlan('/sent', rel, fields);
    shown.t.dom.window.close();
    const sent = await linkPlan('/sent', rel, fields, false);
    sent.t.dom.window.close();
    return { plan: shown.plan, text: shown.shown, sentText: sent.shown, calls: sent.t.calls.filter(c => !c.url.startsWith(`${HOST}/sent`)) };
  }

  it('shows the exact address it sends to, as the URL parser writes it, and sends it there', async () => {
    const cases: Array<[string, Record<string, string>, string]> = [
      // "%2e%2e" is ".." to the URL parser, so this goes to /admin, and the dry run says so.
      ['urn:sent-dots', {}, `${HOST}/admin`],
      // An upper-case scheme is http(s) too; the host is lower-cased, the default port, the dot
      // segments and the fragment dropped, and the quotes encoded.
      ['urn:sent-canon', {}, 'https://good.example/A/c?x=%22y%22&z=%27w%27'],
      // The query is written as URLSearchParams writes it, the same bytes hmc.py writes.
      ['urn:sent-query', { a: '~*x y' }, `${HOST}/q?keep=a+b&a=%7E*x+y`],
      // IDNA as the browser does it, which IDNA 2003 would map to strasse.example.
      ['urn:sent-sharp-s', {}, 'https://xn--strae-oqa.example/x'],
    ];
    for (const [rel, fields, url] of cases) {
      const { plan, calls } = await shownAndSent(rel, fields);
      expect([plan!.transport, plan!.url], rel).toEqual(['http', url]);
      expect(calls.map(c => c.url), rel).toEqual([url]);
    }
  });

  it('shows an address it does not send in its URI form, port and all', async () => {
    const { t, plan } = await linkPlan('/sent', 'urn:sent-v6', {});
    try { expect([plan!.transport, plan!.url]).toEqual(['unknown', 'ftp://%C3%BCser@[::1]:8443/x']); } finally { t.dom.window.close(); }
  });

  it.each([
    ['urn:sent-backslash', { q: 'secret' }, 'the address holds a backslash, a space or a control character'],
    ['urn:sent-plus', { u: '@evil.example/x' }, 'the address does not name its host after "//"'],
    ['urn:sent-user', {}, 'the address carries user information before its host'],
    ['urn:sent-number', {}, "the address's host is a number written other than as four decimal parts"],
    ['urn:sent-tab', {}, 'the address holds a backslash, a space or a control character'],
    ['urn:sent-punycode', {}, 'the address is not a URL'],
  ])('refuses %s, an address a URL parser reads differently from its text, and sends nothing', async (rel, fields, message) => {
    const { plan, text, sentText, calls } = await shownAndSent(rel, fields);
    expect(plan).toBeNull();
    for (const shown of [text, sentText]) expect(shown).toContain(`The request could not be built, so nothing was sent: ${message}`);
    expect(calls).toEqual([]);
  });
});

describe('hypermedia client: template mappings', () => {
  it('makes one field of two mappings of one variable, and of a renaming mapping and a bare one', async () => {
    for (const rel of ['urn:twin-variable', 'urn:twin-renamed']) {
      const { t, plan } = await linkPlan('/twin-mappings', rel, { q: 'v' });
      try {
        expect(formFields(t.document), rel).toEqual(['q']);
        expect(plan!.url, rel).toBe(`${HOST}/s?q=v`);
      } finally { t.dom.window.close(); }
    }
  });
});

describe('hypermedia client: a document\'s size, not its shape, sets the cost', () => {
  it.each(COST_CASES)('lists %s and dry-runs %s within the budget', async (path, rel, controls, fields) => {
    const started = Date.now();
    const t = load(`?url=${encodeURIComponent(HOST + path)}&invoke=${encodeURIComponent(rel)}&dry=1`);
    try {
      const { document } = t;
      await vi.waitFor(() => expect(document.documentElement.dataset['ready'], document.getElementById('status')!.textContent!).toBe('done'), { timeout: 60_000 });
      expect(Date.now() - started, 'link to dry run').toBeLessThan(3_000);
      expect(document.querySelectorAll('.card').length).toBe(controls);
      expect(formFields(document).length).toBe(fields);
      expect(document.getElementById('result')!.textContent).toContain('Dry run — nothing was sent.');
    } finally { t.dom.window.close(); }
  }, 60_000);
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
