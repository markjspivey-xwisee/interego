/**
 * docs/hypermedia-client/hmc.py, the command-line twin of the hypermedia client page, run as a
 * real `python3 -I` process against descriptors this test serves on 127.0.0.1. Everything it
 * reads comes from a document someone else wrote, so it is held to what the page is held to:
 * remote text costs linear time and is not run as a regular expression, and a document cannot
 * point it at anything but an http(s) URL.
 *
 * Python is required. CI's Ubuntu runners have python3; set PYTHON to use another interpreter.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADDRESS_TEXT_PROBLEM, addressTexts, CONTAINER_READS, COST_CASES, costDescriptors, countCases, DOCUMENT_REFUSALS, dryRuns, FETCH_CASES, fetchRoutes,
  hopHeaders, invokeDone, invokeNotFollowed, invokeNotSuccess, invokeOutcomes, jsonldPlans, jsonldRefusals, LANDING_BODY, LINK_CASES, LISTED, LOAD_HEADERS,
  OUTCOME_READ_HEADERS, sharedDescriptors, sharedMarkdown, UNSAFE_CONTROLS, VALUE_CASES, CHOICE_CASES, SWEEP_CASES, BODY_TEXTS, RULE_CASES, EMPTY_CASES,
  WARNING_CASES, TEMPORAL_CASES, SHARED_COST_CASES, EXPANSION_CASES, EXPANSION_PROBLEM, WORK_CASES, workProblem, turtleCostCases,
  layoutBound, shownCases, type HopHeaders } from './hypermedia-client-fixtures.js';

const HMC = fileURLToPath(new URL('../docs/hypermedia-client/hmc.py', import.meta.url));
// What list, list --json and describe may write for a document: a dozen bytes for each of its
// bytes (a field written out takes some 500 bytes, and a template mapping that makes one some 60),
// and a fixed amount besides, however its controls share what they name. Before a list shared
// by many controls was written once, list --json wrote 900 to 5,000 bytes for each.
const OUTPUT_PER_BYTE = 12;
const OUTPUT_SLACK = 64_000;
const PYTHON = process.env['PYTHON'] || 'python3';

// About twice as slow per extra character when the pattern runs; 27 took far over the budget.
const SLOW_PATTERN = '^(a|a)*$';
const SLOW_DEFAULT = 'a'.repeat(27) + 'b';
// A field name that a backtracking `(?:rest-param-.+-)?(.+)$` retries at every position.
const LONG_NAME = 'rest-param-' + '-'.repeat(60_000) + '\nx';

let server: Server;
let base = '';
const seen: string[] = [];
// Each request as the server received it, with its body and content type.
const received: Array<{ line: string; body: string; type: string }> = [];
// Each request as it arrived, in order, with the headers a followed request keeps or must not
// carry, and whether it came through a proxy (its target written in absolute form).
const hops: Array<{ line: string; headers: HopHeaders; proxied: boolean }> = [];
// An HTTP proxy hmc.py is given in its environment, which this server also plays: its
// credentials, and the Proxy-Authorization urllib sends it with them.
const PROXY_LOGIN = 'hmc-test:proxy-pass';
const PROXY_AUTHORIZATION = `Basic ${Buffer.from(PROXY_LOGIN).toString('base64')}`;
// A host only the proxy reaches: hmc.py sends to it through the proxy, and to 127.0.0.1 directly.
const PROXIED = 'http://proxied.test';
// Terminal control sequences: a window title (OSC 0), colour (CSI), a clipboard write (OSC 52),
// a carriage return that would overwrite the line, and a C1 control.
const ESC = '\x1b]0;PWNED-TITLE\x07\x1b[31mRED\x1b[0m\x1b]52;c;cHduZWQ=\x07\r\x9b2J';
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/;
// A local file a descriptor must not be able to make hmc.py read.
const SECRET = 'HMC-LOCAL-FILE-SECRET';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
let dir = '';
let secretUrl = '';
// Large documents whose shape once cost a product of two of their sizes, built once base is known.
let cost: Record<string, string> = {};
// Turtle whose prefixes, base or lists rdflib would make far more of than its size.
const TURTLE_COST = turtleCostCases();

function descriptor(id: string, affordances: object[], graph: object[] = []) {
  return {
    '@context': { hydra: 'http://www.w3.org/ns/hydra/core#', iep: 'https://markjspivey-xwisee.github.io/interego/ns/iep#',
      sh: 'http://www.w3.org/ns/shacl#' },
    '@id': `${base}/${id}`, 'iep:affordance': affordances, '@graph': graph,
  };
}
function routes(): Record<string, () => { status?: number; type?: string; body?: string; headers?: Record<string, string> }> {
  const json = (doc: object) => () => ({ type: 'application/ld+json', body: JSON.stringify(doc) });
  return {
    '/slow-pattern': json(descriptor('slow-pattern', [{ '@id': `${base}/slow-pattern#r`, '@type': 'iep:Affordance',
      'iep:action': 'urn:r', 'hydra:method': 'GET', 'hydra:title': 'Slow pattern', 'hydra:target': `${base}/ok`,
      'hydra:expects': { type: 'object', properties: { q: { type: 'string', pattern: SLOW_PATTERN, default: SLOW_DEFAULT } } } }])),
    '/long-name': json(descriptor('long-name', [{ '@id': `${base}/long-name#n`, '@type': 'iep:Affordance',
      'iep:action': 'urn:n', 'hydra:method': 'GET', 'hydra:title': 'Long name', 'hydra:target': `${base}/ok`,
      'hydra:expects': { '@id': `${base}/long-name#S` } }],
      [{ '@id': `${base}/long-name#S`, '@type': 'sh:NodeShape', 'sh:property': [{ 'sh:path': `${base}/p`, 'sh:name': LONG_NAME },
        { 'sh:path': `${base}/p2`, 'sh:name': 'rest-param-query-limit' }] }])),
    '/ok': () => ({ type: 'text/plain', body: 'fine' }),
    // A HEAD and a GET to a host reached through the proxy, which redirects to this host, reached
    // directly, which redirects back to the proxied host.
    '/via-proxy': json(descriptor('via-proxy', ['HEAD', 'GET'].map(method => ({ '@id': `${base}/via-proxy#${method}`,
      '@type': 'iep:Affordance', 'iep:action': `urn:via-proxy:${method}`, 'hydra:method': method, 'hydra:title': `Proxied ${method}`,
      'hydra:target': `${PROXIED}/answer/to-direct`, 'http://www.w3.org/ns/dcat#mediaType': 'text/plain' })))),
    '/answer/to-direct': () => ({ status: 302, headers: { location: `${base}/answer/to-proxied` } }),
    '/answer/to-proxied': () => ({ status: 302, headers: { location: `${PROXIED}/landing` } }),
    '/schemes': json(descriptor('schemes', [
      ...[['file', secretUrl], ['data', `data:text/plain;base64,${Buffer.from(SECRET).toString('base64')}`], ['ftp', 'ftp://127.0.0.1:9/x']].map(([name, template]) => ({
        '@id': `${base}/schemes#${name}`, '@type': 'iep:Affordance', 'iep:action': `urn:${name}`, 'hydra:method': 'GET',
        'hydra:title': `Template ${name}`, 'hydra:template': template })),
      ...['to-file', 'to-ftp'].map(name => ({ '@id': `${base}/schemes#${name}`, '@type': 'iep:Affordance',
        'iep:action': `urn:${name}`, 'hydra:method': 'GET', 'hydra:title': `Redirect ${name}`, 'hydra:target': `${base}/${name}` })),
    ])),
    '/escapes': json({ ...descriptor('escapes', [
      { '@id': `${base}/escapes#e`, '@type': 'iep:Affordance', 'iep:action': `urn:e${ESC}`,
        'hydra:method': 'GET', 'hydra:title': `ok${ESC}`, 'hydra:description': ESC, 'hydra:target': `${base}/escaped-body`,
        'hydra:expects': { type: 'object', properties: { [`f${ESC}`]: { type: 'string', default: `v${ESC}`, minLength: 999 } } } },
      { '@id': `${base}/escapes#b`, '@type': 'iep:Affordance', 'iep:action': `urn:b${ESC}`,
        'hydra:method': 'GET', 'hydra:title': `body${ESC}`, 'hydra:target': `${base}/escaped-body` },
    ]), 'dct:title': `Title${ESC}`, 'dct:description': `Desc${ESC}` }),
    // A header value may carry a C1 byte (Node refuses C0 ones), so the content type gets one.
    '/escaped-body': () => ({ type: 'text/plain; x=\x9b2J', body: `body${ESC}` }),
    '/to-file': () => ({ status: 302, headers: { location: secretUrl } }),
    '/to-ftp': () => ({ status: 302, headers: { location: 'ftp://127.0.0.1:9/x' } }),
    // sh:in as a JSON-LD list object, the same in a one-element array with @value and @id members,
    // an RDF list of rdf:first / rdf:rest nodes, a plain array, and an empty list object. These
    // fixtures' fields take one value each, so each carries sh:maxCount 1, as Interego's own shapes
    // write one; with no sh:maxCount a property takes a list.
    '/list-enum': json(descriptor('list-enum', [{ '@id': `${base}/list-enum#r`, '@type': 'iep:Affordance',
      'iep:action': 'urn:list-enum', 'hydra:method': 'GET', 'hydra:title': 'List enum read', 'hydra:target': `${base}/list-ok`,
      'hydra:expects': { '@id': `${base}/list-enum#S` } }], [
      { '@id': `${base}/list-enum#S`, '@type': 'sh:NodeShape', 'sh:property': [
        { 'sh:maxCount': 1, 'sh:path': 'urn:p:status', 'sh:name': 'status', 'sh:in': { '@list': ['draft', 'published'] } },
        { 'sh:maxCount': 1, 'sh:path': 'urn:p:wrapped', 'sh:name': 'wrapped', 'sh:in': [{ '@list': [{ '@value': 'low' }, { '@id': `${base}/high` }] }] },
        { 'sh:maxCount': 1, 'sh:path': 'urn:p:nodes', 'sh:name': 'nodes', 'sh:in': { '@id': '_:l1' } },
        { 'sh:maxCount': 1, 'sh:path': 'urn:p:plain', 'sh:name': 'plain', 'sh:in': ['red', 'blue'] },
        { 'sh:maxCount': 1, 'sh:path': 'urn:p:empty', 'sh:name': 'empty', 'sh:in': { '@list': [] } },
      ] },
      { '@id': '_:l1', 'rdf:first': 'one', 'rdf:rest': { '@id': '_:l2' } },
      { '@id': '_:l2', 'rdf:first': { '@value': 'two' }, 'rdf:rest': { '@id': 'http://www.w3.org/1999/02/22-rdf-syntax-ns#nil' } },
    ])),
    '/list-ok': () => ({ type: 'text/plain', body: 'fine' }),
    // A write whose fields are numbers: a required decimal bounded 1 to 10, two integer types, a
    // field with a numeric range but no datatype, an unbounded decimal and a double.
    '/numbers': json(descriptor('numbers', [{ '@id': `${base}/numbers#w`, '@type': 'iep:Affordance',
      'iep:action': 'urn:numbers', 'hydra:method': 'POST', 'hydra:title': 'Numeric write', 'hydra:target': `${base}/num-target`,
      'hydra:expects': { '@id': `${base}/numbers#S` } }], [
      { '@id': `${base}/numbers#S`, '@type': 'sh:NodeShape', 'sh:property': [
        { 'sh:maxCount': 1, 'sh:path': 'urn:p:amount', 'sh:name': 'amount', 'sh:datatype': `${XSD}decimal`, 'sh:minCount': 1, 'sh:minInclusive': 1, 'sh:maxInclusive': 10 },
        { 'sh:maxCount': 1, 'sh:path': 'urn:p:count', 'sh:name': 'count', 'sh:datatype': `${XSD}integer` },
        { 'sh:maxCount': 1, 'sh:path': 'urn:p:size', 'sh:name': 'size', 'sh:datatype': `${XSD}long` },
        { 'sh:maxCount': 1, 'sh:path': 'urn:p:level', 'sh:name': 'level', 'sh:minInclusive': 1, 'sh:maxInclusive': 5 },
        { 'sh:maxCount': 1, 'sh:path': 'urn:p:price', 'sh:name': 'price', 'sh:datatype': `${XSD}decimal` },
        { 'sh:maxCount': 1, 'sh:path': 'urn:p:ratio', 'sh:name': 'ratio', 'sh:datatype': `${XSD}double` },
      ] },
    ])),
    // Number fields whose sh:in entries are written in other ways than the number a person would
    // type, as in the page's test: typed literals "1.0" and "2.50" for a decimal, "1.0E0" and a
    // JSON 0.5 for a double, "+1" and "02" for a long, and JSON 1 and 2.0 for an integer.
    // JSON.stringify writes 2.0 as 2, so the 2.0 is put in the text by hand.
    '/num-enum': () => ({ type: 'application/ld+json', body: JSON.stringify(descriptor('num-enum', [{ '@id': `${base}/num-enum#w`,
      '@type': 'iep:Affordance', 'iep:action': 'urn:num-enum', 'hydra:method': 'POST', 'hydra:title': 'Numeric enum write',
      'hydra:target': `${base}/num-target`, 'hydra:expects': { '@id': `${base}/num-enum#S` } }], [
      { '@id': `${base}/num-enum#S`, '@type': 'sh:NodeShape', 'sh:property': [
        { 'sh:maxCount': 1, 'sh:path': 'urn:p:version', 'sh:name': 'version', 'sh:datatype': `${XSD}decimal`,
          'sh:in': { '@list': [{ '@value': '1.0', '@type': `${XSD}decimal` }, { '@value': '2.50', '@type': `${XSD}decimal` }] } },
        { 'sh:maxCount': 1, 'sh:path': 'urn:p:scale', 'sh:name': 'scale', 'sh:datatype': `${XSD}double`, 'sh:in': [{ '@value': '1.0E0', '@type': `${XSD}double` }, 0.5] },
        { 'sh:maxCount': 1, 'sh:path': 'urn:p:size', 'sh:name': 'size', 'sh:datatype': `${XSD}long`, 'sh:in': { '@list': ['+1', '02'] } },
        { 'sh:maxCount': 1, 'sh:path': 'urn:p:count', 'sh:name': 'count', 'sh:datatype': `${XSD}integer`, 'sh:in': [1, 'COUNT-TWO'] },
      ] },
    ])).replace('"COUNT-TWO"', '2.0') }),
    '/num-target': () => ({ type: 'application/json', body: '{"ok":true}' }),
    // The page test's compacted descriptor: each sh:datatype a compact IRI in a node reference, a
    // string under a term typed "@id" (dt) or "@vocab" (vdt), or a plain "xsd:integer" string; and
    // three node-level shapes that each type a whole body.
    '/compact-types': json({ '@context': [CTX, { xsd: XSD, rdf: RDF_NS, dt: { '@id': 'sh:datatype', '@type': '@id' } },
      { '@vocab': XSD, vdt: { '@id': 'sh:datatype', '@type': '@vocab' } }],
      '@id': `${base}/compact-types`,
      'iep:affordance': [
        { '@id': `${base}/compact-types#w`, '@type': 'iep:Affordance', 'iep:action': 'urn:compact-types', 'hydra:method': 'POST',
          'hydra:title': 'Compact types write', 'hydra:target': `${base}/num-target`, 'hydra:expects': { '@id': `${base}/compact-types#S` } },
        ...['integer', 'boolean', 'JSON'].map(kind => ({ '@id': `${base}/compact-types#${kind}`, '@type': 'iep:Affordance',
          'iep:action': `urn:${kind}-body`, 'hydra:method': 'POST', 'hydra:title': `Compact ${kind} body`, 'hydra:target': `${base}/num-target`,
          'hydra:expects': { '@id': `${base}/compact-types#${kind}-shape` } })),
      ],
      '@graph': [
        { '@id': `${base}/compact-types#S`, '@type': 'sh:NodeShape', 'sh:property': [
          { 'sh:maxCount': 1, 'sh:path': 'urn:p:count', 'sh:name': 'count', 'sh:datatype': { '@id': 'xsd:integer' } },
          { 'sh:maxCount': 1, 'sh:path': 'urn:p:flag', 'sh:name': 'flag', 'sh:datatype': { '@id': 'xsd:boolean' } },
          { 'sh:maxCount': 1, 'sh:path': 'urn:p:data', 'sh:name': 'data', 'sh:datatype': { '@id': 'rdf:JSON' } },
          { 'sh:maxCount': 1, 'sh:path': 'urn:p:size', 'sh:name': 'size', dt: 'xsd:long' },
          { 'sh:maxCount': 1, 'sh:path': 'urn:p:ratio', 'sh:name': 'ratio', vdt: 'double' },
          { 'sh:maxCount': 1, 'sh:path': 'urn:p:plain', 'sh:name': 'plain', 'sh:datatype': 'xsd:integer' },
        ] },
        ...[['integer', 'xsd:integer'], ['boolean', 'xsd:boolean'], ['JSON', 'rdf:JSON']].map(([kind, dt]) => ({
          '@id': `${base}/compact-types#${kind}-shape`, '@type': 'sh:NodeShape', 'rdfs:label': `${kind} body`, 'sh:datatype': { '@id': dt } })),
      ] }),
    // The page test's relative targets, served at a known address, against an explicit @base, and
    // against an @base that makes a relative target a local file.
    '/rel/sub/desc': json({ '@context': REL_CTX, '@id': `${base}/rel/sub/desc`, 'iep:affordance': [
      relOp('root', 'Root api', { '@id': '/api' }), relOp('sibling', 'Sibling api', { '@id': 'api' }), relOp('parent', 'Parent x', { '@id': '../x' }),
      { '@id': '#coerced', '@type': 'iep:Affordance', action: 'iep:relCoerced', 'hydra:method': 'GET', 'hydra:title': 'Coerced target', target: 'coerced?a=1' },
      relOp('bare', 'Bare fragment', { '@id': '#frag' }), relOp('doc', 'Document fragment', { '@id': `${base}/rel/sub/desc#frag2` }),
    ] }),
    '/rel-base': json({ '@context': [REL_CTX, { '@base': `${base}/other/dir/` }], '@id': `${base}/rel-base`,
      'iep:affordance': [relOp('based', 'Based api', { '@id': 'api' }), relOp('based-frag', 'Based fragment', { '@id': '#frag' })] }),
    '/rel-file': json({ '@context': [REL_CTX, { '@base': new URL('.', secretUrl).href }], '@id': `${base}/rel-file`,
      'iep:affordance': [relOp('file', 'File target', { '@id': 'secret.txt' })] }),
    '/api': () => ({ type: 'text/plain', body: 'fine' }),
    // The documents the page's test reads too, and the addresses their controls reach.
    ...Object.fromEntries(Object.entries(sharedDescriptors(base)).map(([path, text]) => [path, () => ({ type: 'application/ld+json', body: text })])),
    ...Object.fromEntries(Object.entries(sharedMarkdown(base)).map(([path, text]) => [path, () => ({ type: 'text/markdown', body: text })])),
    ...Object.fromEntries(Object.entries(cost).map(([path, text]) => [path, () => ({ type: 'application/ld+json', body: text })])),
    ...Object.fromEntries(TURTLE_COST.map(([path, text]) => [path, () => ({ type: 'text/turtle', body: text })])),
    ...Object.fromEntries(['/purge', '/sparql', '/notes/1', '/publish', '/wiki/Caf%C3%A9', '/items', '/lrs/about', '/search', '/tmpl/items/7',
      '/tmpl/shard/ab/abcdef', '/rates/2', '/find', '/dir/items', '/admin', '/q', '/s'].map(path => [path, () => ({ type: 'text/plain', body: 'fine' })])),
    // /dir answers with the usual trailing-slash redirect; /see-other with a 303, after which JSON-LD
    // keeps the address that answered it as the base.
    '/dir': () => ({ status: 301, headers: { location: '/dir/' } }),
    '/dir/': json({ '@context': CTX, '@id': '', 'iep:affordance': [
      { '@id': '#list', '@type': 'iep:Affordance', 'iep:action': { '@id': 'iep:list' }, 'hydra:method': 'GET', 'hydra:title': 'List items',
        'hydra:target': { '@id': 'items' } },
      { '@id': '#create', '@type': 'iep:Affordance', 'iep:action': { '@id': 'iep:create' }, 'hydra:method': 'POST', 'hydra:title': 'Create item',
        'hydra:target': { '@id': 'items' }, 'hydra:expects': { type: 'object', properties: { name: { type: 'string' } } } }] }),
    '/see-other': () => ({ status: 303, headers: { location: '/other/desc' } }),
    // Responses JSON.parse reads otherwise than json.loads: NaN, which is not JSON, and a number past a double.
    '/odd-bodies': json(descriptor('odd-bodies', ['nan', 'large'].map(name => ({ '@id': `${base}/odd-bodies#${name}`,
      '@type': 'iep:Affordance', 'iep:action': `urn:odd-${name}`, 'hydra:method': 'GET', 'hydra:title': `Odd ${name}`,
      'hydra:target': `${base}/odd-${name}` })))),
    '/odd-nan': () => ({ type: 'application/json', body: '{"score":NaN}' }),
    '/odd-large': () => ({ type: 'application/json', body: '{"score":1e400}' }),
    // HyperMarkdown, which is retried as ?format=jsonld with the address's own query kept whole.
    '/fmt': () => ({ type: 'text/markdown', body: '---\ntitle: Format retry\n---\n' }),
    '/other/desc': json({ '@context': CTX, 'iep:affordance': [relOp('see-other', 'See other api', { '@id': 'api' })] }),
  };
}
const CTX = { hydra: 'http://www.w3.org/ns/hydra/core#', iep: 'https://markjspivey-xwisee.github.io/interego/ns/iep#',
  sh: 'http://www.w3.org/ns/shacl#' };
const RDF_NS = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
// A plain string under `target` or `action` is an IRI here, as the kernel's context makes it.
const REL_CTX = { ...CTX, target: { '@id': 'hydra:target', '@type': '@id' }, action: { '@id': 'iep:action', '@type': '@id' } };
const relOp = (id: string, title: string, target: unknown) => ({ '@id': `#${id}`, '@type': 'iep:Affordance',
  'iep:action': `urn:rel-${id}`, 'hydra:method': 'GET', 'hydra:title': title, 'hydra:target': target });

interface Run { code: number | null; stdout: string; stderr: string; ms: number; timedOut: boolean }
/**
 * Run hmc.py without blocking this process, which is also the server it talks to. Its environment
 * is minimal, with no proxy variables, so requests to 127.0.0.1 go straight there, unless `env`
 * gives some.
 */
function hmc(args: string[], timeoutMs = 30_000, env: Record<string, string> = {}, memoryMb = 0): Promise<Run> {
  return new Promise(resolve => {
    const started = Date.now();
    // With a memory bound, hmc.py runs with that much address space and no more, so a run that
    // would build far more than its document holds fails where it starts to, not after it.
    const argv = memoryMb ? ['-I', '-c', 'import resource, runpy, sys; resource.setrlimit(resource.RLIMIT_AS, (int(sys.argv[1]),) * 2); ' +
      'sys.argv = sys.argv[2:]; runpy.run_path(sys.argv[0], run_name="__main__")', String(memoryMb * 1024 * 1024), HMC, ...args] : ['-I', HMC, ...args];
    const child = spawn(PYTHON, argv, { env: { PATH: process.env['PATH'] || '', LANG: 'C.UTF-8', NO_PROXY: '*', no_proxy: '*', ...env } });
    let stdout = ''; let stderr = ''; let timedOut = false;
    child.stdout.setEncoding('utf8').on('data', d => { stdout += d; });
    child.stderr.setEncoding('utf8').on('data', d => { stderr += d; });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr, ms: Date.now() - started, timedOut }); });
  });
}

/** Each problem a refused invoke prints, whole. */
const problems = (stderr: string) => stderr.split('\n').filter(line => line.startsWith('  - ')).map(line => line.slice(4));

beforeAll(async () => {
  const probe = spawnSync(PYTHON, ['--version'], { encoding: 'utf8' });
  if (probe.status !== 0) throw new Error(`${PYTHON} is needed to test docs/hypermedia-client/hmc.py (set PYTHON to another interpreter): ${probe.error || probe.stderr}`);
  dir = mkdtempSync(join(tmpdir(), 'hmc-'));
  writeFileSync(join(dir, 'secret.txt'), SECRET);
  secretUrl = new URL(`file://${join(dir, 'secret.txt')}`).href;
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || '/', base);
    const line = `${req.method} ${url.pathname}${url.search}`;
    seen.push(line);
    hops.push({ line, headers: hopHeaders(req.headers), proxied: /^https?:/i.test(req.url || '') });
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      received.push({ line, body: Buffer.concat(chunks).toString('utf8'), type: String(req.headers['content-type'] || '') });
      const fetched = Object.prototype.hasOwnProperty.call(fetchRoutes(base), url.pathname) ? fetchRoutes(base)[url.pathname]!(url.searchParams.get('format')) : undefined;
      if (fetched === 'no answer') { req.socket.destroy(); return; }
      // A redirect that promises a body and sends one byte of it, then nothing, until the client closes.
      if (fetched && 'redirect' in fetched && fetched.unending) {
        res.writeHead(fetched.status || 302, { location: fetched.redirect, 'content-length': '1048576' }).write('x');
        return;
      }
      if (fetched && 'redirect' in fetched) { res.writeHead(fetched.status || 302, { location: fetched.redirect }).end(fetched.body); return; }
      // Node writes no body in answer to a HEAD, so a host that does writes the answer itself.
      if (fetched && fetched.headBody && req.method === 'HEAD' && typeof fetched.type === 'string') {
        req.socket.end(`HTTP/1.1 ${fetched.status || 200} OK\r\ncontent-type: ${fetched.type}\r\n` +
          `content-length: ${Buffer.byteLength(fetched.body)}\r\nconnection: close\r\n\r\n${fetched.body}`);
        return;
      }
      // A list of types is that many Content-Type headers.
      if (fetched) { res.setHeader('content-type', fetched.type); res.writeHead(fetched.status || 200).end(fetched.body); return; }
      const route = Object.prototype.hasOwnProperty.call(routes(), url.pathname) ? routes()[url.pathname] : undefined;
      if (!route) { res.writeHead(404, { 'content-type': 'text/plain' }).end('missing'); return; }
      const out = route();
      res.writeHead(out.status || 200, { 'content-type': out.type || 'text/plain', ...out.headers }).end(out.body || '');
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cost = costDescriptors(base);
});
afterAll(async () => {
  await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve());
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('hmc.py: remote text costs linear time', () => {
  it('does not run a remote pattern, and sends the value for the server to check', async () => {
    const r = await hmc(['invoke', `${base}/slow-pattern`, 'urn:r']);
    expect(r.timedOut, 'killed after 30 s').toBe(false);
    expect(r.ms, 'run time').toBeLessThan(3_000);
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect(seen).toContain(`GET /ok?q=${SLOW_DEFAULT}`);
    expect(r.stdout).toContain('HTTP 200');
  }, 40_000);

  it('reads a long crafted field name in linear time, keeps a name with a line break whole, and still shortens rest-param- names', async () => {
    const r = await hmc(['describe', `${base}/long-name`, 'urn:n']);
    expect(r.timedOut, 'killed after 30 s').toBe(false);
    expect(r.ms, 'run time').toBeLessThan(3_000);
    expect(r.code, r.stderr).toBe(0);
    const control = JSON.parse(r.stdout) as { fields: Array<{ name: string; pattern: string | null }> };
    expect(control.fields.map(f => f.name)).toEqual([LONG_NAME, 'limit']);
  }, 40_000);

  it('still reports a field\'s pattern, for a person or a program to read', async () => {
    const r = await hmc(['describe', `${base}/slow-pattern`, 'urn:r']);
    expect(r.code, r.stderr).toBe(0);
    expect((JSON.parse(r.stdout) as { fields: Array<{ pattern: string }> }).fields[0]!.pattern).toBe(SLOW_PATTERN);
  });
});

describe('hmc.py: a load whose requests fail, as the page\'s', () => {
  // With rdflib hmc.py reads Turtle, which the page never does; without it, it is the page's twin here too.
  const READS_TURTLE = spawnSync(PYTHON, ['-I', '-c', 'import rdflib'], { encoding: 'utf8' }).status === 0;
  const PROBLEMS = {
    'no answer': /^error: .*(Remote end closed connection without response|Connection reset by peer|redirected more than 20 times)/,
    // An answer past RESPONSE_MAX bytes is read no further, whatever its status.
    'too large': /^error: The answer to http:\/\/127\.0\.0\.1:\d+\/[\w-]+ is larger than 8388608 bytes, so it was not read\.$/,
    turtle: /^error: This descriptor was served as Turtle\. Install rdflib/,
    'none readable': /^error: Could not fetch a JSON-LD, Turtle, or HyperMarkdown descriptor from /,
  } as const;
  const REFUSED_NOTE = /^The JSON-LD answer to http:\/\/127\.0\.0\.1:\d+\/[\w-]+\?format=jsonld is refused, so the controls read from the HyperMarkdown answer are listed and none is invoked: ./;
  const REFUSED_CONTROL = /^the JSON-LD answer to http:\/\/127\.0\.0\.1:\d+\/[\w-]+\?format=jsonld is refused, and what it says of this control is not known, so it is not invoked: ./;

  it.each(FETCH_CASES)('loads %s', async (address, outcome) => {
    const before = seen.length;
    const hopsBefore = hops.length;
    const r = await hmc(['list', `${base}${address}`, '--json']);
    // Every request of a load, at each address a redirect leads it to, is a GET with the load's Accept.
    const sent = hops.slice(hopsBefore);
    expect(sent.map(hop => [hop.line.slice(0, hop.line.indexOf(' ')), hop.proxied, hop.headers]), r.stderr)
      .toEqual(sent.map(() => ['GET', false, LOAD_HEADERS]));
    const path = address.split('?')[0]!;
    const requests = seen.slice(before).map(line => new URL(line.slice(line.indexOf(' ') + 1), base)).filter(u => u.pathname === path);
    const asked = [...new Set(requests.map(u => u.searchParams.get('format')))];
    if (READS_TURTLE && outcome.withTurtle) {
      expect([r.code, asked], r.stderr).toEqual([0, outcome.withTurtle]);
      return;
    }
    expect(asked, r.stderr).toEqual(outcome.asked);
    if (outcome.requests !== undefined) expect(requests, r.stderr).toHaveLength(outcome.requests);
    if ('titles' in outcome) {
      expect(r.code, r.stderr).toBe(0);
      const listed = JSON.parse(r.stdout) as { problem: string | null; controls: Array<{ title: string; unsafe: boolean; problem: string | null }> };
      expect(listed.controls.map(c => c.title).sort()).toEqual(outcome.titles);
      if (!outcome.refused) {
        expect(listed.problem).toBeNull();
        return;
      }
      // The answer listed is not read as safe: every control is refused, naming the JSON-LD's problem.
      const because = outcome.refused === true ? '' : outcome.refused;
      expect(listed.problem).toMatch(REFUSED_NOTE);
      expect(listed.problem).toContain(because);
      for (const control of listed.controls) {
        expect([control.unsafe, control.problem]).toEqual([true, expect.stringMatching(REFUSED_CONTROL)]);
        expect(control.problem).toContain(because);
      }
      const invoked = await hmc(['invoke', `${base}${address}`, 'md-read', '--confirm']);
      expect([invoked.code, problems(invoked.stderr)]).toEqual([2, [listed.controls[0]!.problem]]);
    } else {
      expect([r.code, r.stdout]).toEqual([1, '']);
      if (outcome.problem === 'refused') expect(r.stderr.trim()).toBe(`error: ${outcome.refused}`);
      else expect(r.stderr.trim()).toMatch(PROBLEMS[outcome.problem]);
    }
  });
});

describe('hmc.py: http and https only', () => {
  const REFUSED = /sends requests to http and https URLs only/;

  it.each(['file', 'data', 'ftp'])('refuses a %s: template from a descriptor, before any request', async name => {
    const r = await hmc(['invoke', `${base}/schemes`, `urn:${name}`]);
    expect(r.code).not.toBe(0);
    expect(r.stdout + r.stderr).not.toContain(SECRET);
    expect(r.stderr).toMatch(REFUSED);
    // The listing does not call it an http control either.
    const d = await hmc(['describe', `${base}/schemes`, `urn:${name}`]);
    expect((JSON.parse(d.stdout) as { transport: string }).transport).toBe('unknown');
  });

  it.each(['to-file', 'to-ftp'])('refuses a redirect %s', async name => {
    const r = await hmc(['invoke', `${base}/schemes`, `urn:${name}`]);
    expect(r.code).not.toBe(0);
    expect(r.stdout + r.stderr).not.toContain(SECRET);
    expect(r.stderr).toMatch(/refused a redirect to (file|ftp):/);
  });

  it('refuses a descriptor address as it is given, before urlsplit drops a tab, a line break or a space from it, as the page does', async () => {
    for (const given of addressTexts(base)) {
      const before = seen.length;
      const r = await hmc(['list', given]);
      // The terminal is shown a carriage return as an escape, as every control character in text mode.
      const shown = `error: ${ADDRESS_TEXT_PROBLEM}; nothing is sent to ${given.replace(/\r/g, '\\x0d')}`;
      expect([r.code, r.stderr.trim()], JSON.stringify(given)).toEqual([1, shown.trim()]);
      expect(seen.slice(before), JSON.stringify(given)).toEqual([]);
    }
  });

  it('refuses a descriptor address that is not http(s)', async () => {
    const r = await hmc(['list', secretUrl]);
    expect(r.code).not.toBe(0);
    expect(r.stdout + r.stderr).not.toContain(SECRET);
    expect(r.stderr).toMatch(REFUSED);
  });
});

describe('hmc.py: an invoke goes only where its dry run says, and only a 2xx is done', () => {
  // The table is read again once the server's address is known.
  it.each(invokeOutcomes('').map(([title]) => [title] as const))('ends %s as the page does, in text and --json alike', async title => {
    const [, rel, method, url, end, reached] = invokeOutcomes(base).find(row => row[0] === title)!;
    for (const mode of [[], ['--json']]) {
      const before = hops.length;
      const r = await hmc(['invoke', `${base}/outcomes`, rel, '--confirm', ...mode]);
      const where = `${title} ${mode.join('')}: ${r.stdout}${r.stderr}`;
      // The host receives the request once, at the address shown; a GET or HEAD also where it is
      // redirected, as the same method, asking for the same type, and with nothing else.
      const sent = hops.slice(before).filter(hop => / \/(answer\/|landing)/.test(hop.line));
      expect(sent.map(hop => hop.line), where).toEqual(reached);
      if (method === 'GET' || method === 'HEAD') {
        expect(sent.map(hop => [hop.headers, hop.proxied]), where).toEqual(sent.map(() => [OUTCOME_READ_HEADERS, false]));
      }
      if ('loop' in end) {
        expect([r.code, r.stdout, r.stderr.trim()], where)
          .toEqual([1, '', `error: ${url} was redirected more than 20 times, more than fetch follows, so the request failed`]);
        continue;
      }
      if ('refused' in end) {
        expect([r.code, r.stdout, r.stderr.trim()], where)
          .toEqual([1, '', `error: hmc.py sends requests to http and https URLs only; refused a redirect to ${end.refused}`]);
        continue;
      }
      // A Location a URL parser reads otherwise than its text is refused, as such an address is.
      if ('backslash' in end) {
        expect([r.code, r.stdout, r.stderr.trim()], where)
          .toEqual([1, '', `error: hmc.py refused the redirect from ${url} to ${end.backslash}: ${ADDRESS_TEXT_PROBLEM}; nothing was sent there`]);
        continue;
      }
      const location = 'redirect' in end && end.location !== null ? new URL(end.location, url).href : null;
      const done = 'answer' in end && end.answer >= 200 && end.answer < 300;
      const landed = 'answer' in end && end.landed ? `${base}${end.landed}` : url;
      const outcome = 'redirect' in end ? invokeNotFollowed(method, url, end.redirect, location)
        : (done ? invokeDone : invokeNotSuccess)(url, end.answer, landed);
      expect(r.code, where).toBe(done ? 0 : 4);
      // A HEAD's answer has no body, however the host answers it; a GET that lands at /landing reads it.
      // A redirect not followed is read only to its headers, as the page's opaque redirect has no body.
      const landedBody = 'landed' in end && end.landed && end.landed.startsWith('/landing');
      if (mode.length) {
        const out = JSON.parse(r.stdout) as { done: boolean; outcome: string; redirect?: unknown;
          response: { status: number; landed: string; bodyText: string } };
        expect([out.done, out.outcome, out.redirect ?? null, out.response.status, out.response.landed], where)
          .toEqual([done, outcome, 'redirect' in end ? { status: end.redirect, location } : null, 'redirect' in end ? end.redirect : end.answer,
            'redirect' in end ? url : landed]);
        if (method === 'HEAD' || 'redirect' in end) expect(out.response.bodyText, where).toBe('');
        else if (landedBody) expect(out.response.bodyText, where).toBe(LANDING_BODY);
      } else {
        expect(r.stdout.split('\n'), where).toContain(outcome);
        if (method === 'HEAD') expect(r.stdout.split('\n'), where).not.toContain(LANDING_BODY);
        else if (landedBody) expect(r.stdout.split('\n'), where).toContain(LANDING_BODY);
      }
    }
  });

  it('says nothing was sent, and exits 3 in text and --json alike, for a write with no plain-HTTP transport', async () => {
    const before = seen.length;
    const text = await hmc(['invoke', `${base}/defined-terms`, 'urn:defined:target', '--confirm']);
    expect([text.code, text.stdout.split('\n')], text.stderr).toEqual([3, expect.arrayContaining([
      'No plain-HTTP transport is available for this control, so nothing was sent. Use the Interego relay MCP call documented in request.mcp.'])]);
    const json = await hmc(['invoke', `${base}/defined-terms`, 'urn:defined:target', '--confirm', '--json']);
    expect(json.code, json.stderr).toBe(3);
    expect((JSON.parse(json.stdout) as { done: boolean; blocked: string })).toMatchObject({ done: false, blocked: 'mcp-required' });
    expect(seen.slice(before).filter(line => !line.startsWith('GET /defined-terms'))).toEqual([]);
  });
});

describe('hmc.py: what a response is shown as grows with its size, not with the product of its parts', () => {
  // Each /shown control, invoked: hmc.py shows its answer as indented JSON or its text, or nothing of
  // it, as shownCases says, with the note the page writes for the same rule. It shows no table, so
  // it writes a SPARQL result as the JSON it is. Text mode writes at most 8,000 characters of a
  // body; --json writes it whole, so what it writes is counted against what laying out a response
  // of its size may add (layoutBound), with its text, escaped, beside it.
  it.each(shownCases().map(c => [c.name] as const))('shows /shown/%s as the page does, within what its size allows, in text and --json alike', async name => {
    const c = shownCases().find(one => one.name === name)!;
    const url = `${base}/shown/${name}`;
    const text = await hmc(['invoke', `${base}/shown`, `urn:shown:${name}`]);
    expect([text.code, text.stderr, text.timedOut]).toEqual([0, '', false]);
    const lines = text.stdout.split('\n');
    const at = lines.indexOf(invokeDone(url, 200));
    expect(at, text.stdout.slice(0, 2_000)).toBeGreaterThan(0);
    expect(lines[at - 1]).toBe(`HTTP 200  ${c.type}`);
    const shown = c.hmc === 'json' ? JSON.stringify(JSON.parse(c.body), null, 2) : c.hmc === 'text' ? c.body : null;
    const written = shown === null ? '' : shown.length < 8_000 ? `${shown}\n` : `${shown.slice(0, 8_000)}\n…\n`;
    expect(lines.slice(at + 1).join('\n')).toBe(`${c.hmcNote === null ? '' : `${c.hmcNote}\n`}${written}`);
    expect(text.stdout.length, 'text written').toBeLessThan(10_000);
    const json = await hmc(['invoke', `${base}/shown`, `urn:shown:${name}`, '--json']);
    expect([json.code, json.stderr, json.timedOut]).toEqual([0, '', false]);
    const out = JSON.parse(json.stdout) as { done: boolean; outcome: string; response: { bodyText: string | null; body: unknown; note?: string | null } };
    expect([out.done, out.outcome, out.response.note ?? null]).toEqual([true, invokeDone(url, 200), c.hmcNote]);
    // A response with no note has no `note`, so an honest response's --json is what it was before there were notes.
    expect('note' in out.response, 'note given').toBe(c.hmcNote !== null);
    expect(out.response.bodyText).toBe(c.hmc === 'nothing' ? null : c.body);
    expect(out.response.body).toEqual(c.hmc === 'json' ? JSON.parse(c.body) : null);
    expect(json.stdout.length, '--json written').toBeLessThanOrEqual(layoutBound(c.bytes) + 8 * c.bytes + 20_000);
  }, 60_000);
});

describe('hmc.py: through an HTTP proxy its environment names', () => {
  // urllib writes the proxy's credentials into a request's headers, so a redirect that copied them
  // would hand them to the next host. A browser never sends Proxy-Authorization to a host.
  it.each(['HEAD', 'GET'])('sends a %s\'s Proxy-Authorization only on each hop that goes through the proxy, never to a host', async method => {
    const before = hops.length;
    const proxy = { http_proxy: `http://${PROXY_LOGIN}@${base.slice('http://'.length)}`, no_proxy: '127.0.0.1', NO_PROXY: '127.0.0.1' };
    const r = await hmc(['invoke', `${base}/via-proxy`, `urn:via-proxy:${method}`, '--json'], 30_000, proxy);
    expect(r.code, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout) as { outcome: string; response: { landed: string; bodyText: string } };
    expect([out.outcome, out.response.landed, out.response.bodyText])
      .toEqual([invokeDone(`${PROXIED}/answer/to-direct`, 200, `${PROXIED}/landing`), `${PROXIED}/landing`, method === 'HEAD' ? '' : LANDING_BODY]);
    const proxied = { ...OUTCOME_READ_HEADERS, 'proxy-authorization': PROXY_AUTHORIZATION };
    expect(hops.slice(before).map(hop => [hop.line, hop.proxied, hop.headers])).toEqual([
      ['GET /via-proxy', false, LOAD_HEADERS],
      [`${method} /answer/to-direct`, true, proxied],
      [`${method} /answer/to-proxied`, false, OUTCOME_READ_HEADERS],
      [`${method} /landing`, true, proxied]]);
  });
});

describe('hmc.py: SHACL sh:in lists', () => {
  it.each([['urn:empty:or-array', 'sh:or'], ['urn:empty:xone-array', 'sh:xone'], ['urn:empty:language-nil', 'sh:languageIn'], ['urn:empty:enum', 'enum']])(
    'describe and list --json name an empty %s list as the field\'s (%s), where "in" says nothing of it', async (rel, constraint) => {
      const d = await hmc(['describe', `${base}/empty-lists`, rel]);
      expect(d.code, d.stderr).toBe(0);
      const fields = (JSON.parse(d.stdout) as { fields: Array<{ empty: string | null }> }).fields;
      expect(fields.map(f => f.empty)).toEqual([constraint]);
      const doc = await listed('/empty-lists');
      expect(doc.fields.filter(f => f.empty === constraint).length).toBeGreaterThan(0);
    });
  it('reads the members of a JSON-LD list, an RDF list and a plain array, accepts them, and refuses a value for an empty list', async () => {
    const d = await hmc(['describe', `${base}/list-enum`, 'urn:list-enum']);
    expect(d.code, d.stderr).toBe(0);
    const fields = (JSON.parse(d.stdout) as { fields: Array<{ name: string; in: unknown[]; empty: string | null }> }).fields;
    expect(Object.fromEntries(fields.map(f => [f.name, f.in]))).toEqual({
      status: ['draft', 'published'], wrapped: ['low', `${base}/high`], nodes: ['one', 'two'], plain: ['red', 'blue'], empty: [],
    });
    // describe names the list given empty, which "in" alone does not tell from no list.
    expect(Object.fromEntries(fields.map(f => [f.name, f.empty]))).toEqual({ status: null, wrapped: null, nodes: null, plain: null, empty: 'sh:in' });
    // list --json names the empty list as the field's, never null, which says it names none.
    const doc = await listed('/list-enum');
    const named = Object.fromEntries(doc.fields.map(f => [f.name, f.in === null ? null : doc.inLists[f.in]]));
    expect(named).toEqual({ status: ['draft', 'published'], wrapped: ['low', `${base}/high`], nodes: ['one', 'two'], plain: ['red', 'blue'], empty: [] });
    expect(Object.fromEntries(doc.fields.map(f => [f.name, f.empty]))).toEqual({ status: null, wrapped: null, nodes: null, plain: null, empty: 'sh:in' });
    const chosen = ['--field', 'status=draft', '--field', 'wrapped=low', '--field', 'nodes=two', '--field', 'plain=blue'];
    // An empty list allows no value: one given for it is refused, and nothing is sent.
    const refused = await hmc(['invoke', `${base}/list-enum`, 'urn:list-enum', ...chosen, '--field', 'empty=anything']);
    expect(refused.code, refused.stderr).toBe(2);
    expect(problems(refused.stderr)).toEqual(['empty: its shape allows no value (sh:in is empty), so it is not sent']);
    expect(seen.some(line => line.includes('empty=anything'))).toBe(false);
    const r = await hmc(['invoke', `${base}/list-enum`, 'urn:list-enum', ...chosen]);
    expect(r.code, r.stderr).toBe(0);
    expect(seen).toContain('GET /list-ok?status=draft&wrapped=low&nodes=two&plain=blue');
  });
});

describe('hmc.py: numeric fields', () => {
  const sent = () => seen.filter(s => s.startsWith('POST /num-target')).length;
  it.each([
    ...['abc', 'NaN', 'Infinity', 'nan', 'inf', '0x10', '12abc', '1_000', '1,5'].map(v => ['amount', v, 'amount: not a number']),
    ['amount', '1e999', 'amount: not a finite number'],
    // Only spaces are no number, and are refused as one, never read as an empty field.
    ['amount', '   ', 'amount: not a number'],
    ['count', '1.5', 'count: not an integer'],
    ['count', '12abc', 'count: not an integer'],
    ['count', '1e3', 'count: not an integer'],
    ['count', '1_000', 'count: not an integer'],
    ['size', '1.5', 'size: not an integer'],
    // A bound on a field with no number datatype is not compared: SHACL compares a value's own
    // datatype, so "3" would be text that no number bounds.
    ['level', 'abc', 'level: its sh:minInclusive 1 bounds a field that takes no number, which this client does not compare, so it is not sent'],
    ['level', '3', 'level: its sh:minInclusive 1 bounds a field that takes no number, which this client does not compare, so it is not sent'],
    // Only a space, tab, CR or LF around a number is not part of it, the set the page strips too.
    ['amount', '\x1c5', 'amount: not a number'],
    ['amount', '5\u00a0', 'amount: not a number'],
    ['amount', '5\u0085', 'amount: not a number'],
    // A decimal is exact, so one that a JSON number (a double) would change is refused, as on the
    // page: the first would pass maxInclusive 10 as 10.
    ['amount', '10.0000000000000001', 'amount: decimal cannot be sent exactly'],
    ['price', '9007199254740993', 'price: decimal cannot be sent exactly'],
    ['price', '0.10000000000000001', 'price: decimal cannot be sent exactly'],
    ['price', '1e-400', 'price: decimal cannot be sent exactly'],
    // A JSON number cannot carry an integer past 2^53 exactly, so hmc.py refuses it as the page does.
    ['size', '9007199254740993', 'size: integer too large to send exactly'],
    ['size', '+1234567890123456789', 'size: integer too large to send exactly'],
    ['size', '9'.repeat(5000), 'size: integer too large to send exactly'],
  ])('refuses %s=%j with a confirmed write, and sends nothing', async (name, value, message) => {
    const before = sent();
    const r = await hmc(['invoke', `${base}/numbers`, 'urn:numbers', '--field', 'amount=2', '--field', `${name}=${value}`, '--confirm']);
    expect(r.code, r.stdout + r.stderr).toBe(2);
    expect(r.stderr).toContain('Validation failed');
    expect(r.stderr).toContain(message);
    expect(sent()).toBe(before);
  });

  it('sends numbers written as numbers as numbers, an integer up to 2^53 - 1 exactly', async () => {
    // A double is the double nearest its text, the value XSD gives that text. The long is the
    // largest integer a double holds exactly, so it is sent as written.
    const dry = await hmc(['invoke', `${base}/numbers`, 'urn:numbers', '--field', 'amount= 2.5 ', '--field', 'count=-3',
      '--field', 'size=+9007199254740991', '--field', 'price=\t2.50\r\n',
      '--field', 'ratio=0.10000000000000001', '--dry-run', '--json']);
    expect(dry.code, dry.stderr).toBe(0);
    expect(dry.stdout).toContain('"size": 9007199254740991');
    const body = (JSON.parse(dry.stdout) as { request: { body: Record<string, unknown> } }).request.body;
    expect(body).toEqual({ amount: 2.5, count: -3, size: 9007199254740991, price: 2.5, ratio: 0.1 });
    const before = sent();
    const live = await hmc(['invoke', `${base}/numbers`, 'urn:numbers', '--field', 'amount=2.5', '--confirm']);
    expect(live.code, live.stderr).toBe(0);
    expect(sent()).toBe(before + 1);
  });
});

describe('hmc.py: numbers in an enum', () => {
  const plan = async (fields: string[]) => {
    const r = await hmc(['invoke', `${base}/num-enum`, 'urn:num-enum', ...fields.flatMap(f => ['--field', f]), '--dry-run', '--json']);
    return { r, body: r.code === 0 ? (JSON.parse(r.stdout) as { request: { body: unknown } }).request.body : null };
  };

  it('accepts an entry as the number it is, as the page does, however either is written', async () => {
    const d = await hmc(['describe', `${base}/num-enum`, 'urn:num-enum']);
    expect(d.code, d.stderr).toBe(0);
    const fields = (JSON.parse(d.stdout) as { fields: Array<{ name: string; in: unknown[] }> }).fields;
    expect(Object.fromEntries(fields.map(f => [f.name, f.in]))).toEqual({
      version: ['1.0', '2.50'], scale: ['1.0E0', 0.5], size: ['+1', '02'], count: [1, 2],
    });
    const cases: Array<[string[], Record<string, number>]> = [
      // Each entry as it is offered, which is what the page's select submits.
      [['version=1.0', 'scale=1.0E0', 'size=+1', 'count=1'], { version: 1, scale: 1, size: 1, count: 1 }],
      [['version=2.50', 'scale=0.5', 'size=02', 'count=2'], { version: 2.5, scale: 0.5, size: 2, count: 2 }],
      // The same numbers written another way.
      [['version=1', 'scale=1', 'size=1', 'count=2'], { version: 1, scale: 1, size: 1, count: 2 }],
      [['version=2.5', 'scale=5e-1', 'size=2', 'count=+1'], { version: 2.5, scale: 0.5, size: 2, count: 1 }],
    ];
    for (const [given, body] of cases) {
      const { r, body: sent } = await plan(given);
      expect(r.code, `${given.join(' ')}: ${r.stderr}`).toBe(0);
      expect(sent, given.join(' ')).toEqual(body);
    }
  });

  it.each([
    ['version=3', 'version: must be one of'],
    ['scale=2', 'scale: must be one of'],
    ['size=3', 'size: must be one of'],
    ['count=3', 'count: must be one of'],
  ])('refuses %s, which is no entry', async (given, message) => {
    const { r } = await plan([given]);
    expect(r.code, r.stdout + r.stderr).toBe(2);
    expect(r.stderr).toContain(message);
  });
});

describe('hmc.py: compact datatype IRIs', () => {
  type Plan = { request: { url: string | null; transport: string; body: unknown; bodyText: string | null; headers: Record<string, string> } };
  const plan = async (rel: string, fields: Record<string, string>) => {
    const r = await hmc(['invoke', `${base}/compact-types`, rel, ...Object.entries(fields).flatMap(([k, v]) => ['--field', `${k}=${v}`]), '--dry-run', '--json']);
    return { r, request: r.code === 0 ? (JSON.parse(r.stdout) as Plan).request : null };
  };

  it('reads each datatype as its full IRI and types the field by it', async () => {
    const d = await hmc(['describe', `${base}/compact-types`, 'urn:compact-types']);
    expect(d.code, d.stderr).toBe(0);
    const fields = (JSON.parse(d.stdout) as { fields: Array<{ name: string; datatype: string; jsonKind: string | null }> }).fields;
    expect(Object.fromEntries(fields.map(f => [f.name, [f.datatype, f.jsonKind]]))).toEqual({
      count: [`${XSD}integer`, null], flag: [`${XSD}boolean`, null], data: [`${RDF_NS}JSON`, 'json'], size: [`${XSD}long`, null],
      ratio: [`${XSD}double`, null], plain: ['xsd:integer', null],
    });
    const bad = await plan('urn:compact-types', { count: '1.5', flag: 'maybe', data: 'nope', size: '1.5', ratio: 'abc', plain: '1.5' });
    expect(bad.r.code, bad.r.stdout + bad.r.stderr).toBe(2);
    for (const message of ['count: not an integer', 'flag must be a boolean', 'data must be JSON', 'size: not an integer',
      'ratio: not a number', 'plain: not an integer']) expect(problems(bad.r.stderr), message).toContain(message);
    const good = await plan('urn:compact-types', { count: '12', flag: '1', data: '{"a":[1,2]}', size: '+7', ratio: '0.5', plain: '3' });
    expect(good.r.code, good.r.stderr).toBe(0);
    expect(good.request!.body).toEqual({ count: 12, flag: true, data: { a: [1, 2] }, size: 7, ratio: 0.5, plain: 3 });
  });

  it.each([
    ['integer', '1.5', 'body: not an integer', '12', '12'],
    ['boolean', 'yes', 'body must be a boolean', '1', 'true'],
    ['JSON', 'nope', 'body must be JSON', '{"a": 1}', '{"a": 1}'],
  ])('types a node-level shape\'s %s body by its compact datatype', async (kind, wrong, message, right, sent) => {
    const bad = await plan(`urn:${kind}-body`, { body: wrong });
    expect(bad.r.code, bad.r.stdout + bad.r.stderr).toBe(2);
    expect(bad.r.stderr).toContain(message);
    const good = await plan(`urn:${kind}-body`, { body: right });
    expect(good.r.code, good.r.stderr).toBe(0);
    expect(good.request!.bodyText).toBe(sent);
    if (kind === 'JSON') expect(good.request!.headers['Content-Type']).toBe('application/json');
  });
});

describe('hmc.py: relative targets', () => {
  const describeIn = async (path: string, rel: string) => {
    const r = await hmc(['describe', `${base}${path}`, rel]);
    expect(r.code, r.stderr).toBe(0);
    return JSON.parse(r.stdout) as { transport: string; target: string };
  };
  const dryRun = async (path: string, rel: string) => {
    const r = await hmc(['invoke', `${base}${path}`, rel, '--dry-run', '--json']);
    expect(r.code, r.stderr).toBe(0);
    return (JSON.parse(r.stdout) as { request: { transport: string; url: string | null } }).request;
  };

  it('resolves a relative hydra:target against the descriptor address, and sends it there', async () => {
    const cases: Array<[string, string]> = [['urn:rel-root', `${base}/api`], ['urn:rel-sibling', `${base}/rel/sub/api`],
      ['urn:rel-parent', `${base}/rel/x`], ['iep:relCoerced', `${base}/rel/sub/coerced?a=1`]];
    for (const [rel, url] of cases) {
      const d = await describeIn('/rel/sub/desc', rel);
      expect([d.transport, d.target], rel).toEqual(['http', url]);
      const request = await dryRun('/rel/sub/desc', rel);
      expect([request.transport, request.url], rel).toEqual(['http', url]);
    }
    // A fragment of this document, written "#frag" or in full, is an action junction, not an address.
    for (const rel of ['urn:rel-bare', 'urn:rel-doc']) {
      expect((await describeIn('/rel/sub/desc', rel)).transport, rel).toBe('junction');
      expect((await dryRun('/rel/sub/desc', rel)).url, rel).toBeNull();
    }
    const live = await hmc(['invoke', `${base}/rel/sub/desc`, 'urn:rel-root']);
    expect(live.code, live.stderr).toBe(0);
    expect(seen).toContain('GET /api');
  });

  it('resolves against the context\'s @base when it gives one', async () => {
    expect(await describeIn('/rel-base', 'urn:rel-based')).toMatchObject({ transport: 'http', target: `${base}/other/dir/api` });
    expect((await describeIn('/rel-base', 'urn:rel-based-frag')).transport).toBe('junction');
  });

  it('still fetches nothing that is not http(s) once resolved', async () => {
    const d = await describeIn('/rel-file', 'urn:rel-file');
    expect(d.target).toBe(secretUrl);
    expect(d.transport).not.toBe('http');
    const r = await hmc(['invoke', `${base}/rel-file`, 'urn:rel-file']);
    expect(r.code).not.toBe(0);
    expect(r.stdout + r.stderr).not.toContain(SECRET);
  });
});

describe('hmc.py: remote text reaches the terminal as text', () => {
  it('shows control characters in a listing as visible escapes', async () => {
    const r = await hmc(['list', `${base}/escapes`]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).not.toMatch(CONTROL);
    expect(r.stdout).toContain('Title\\x1b]0;PWNED-TITLE\\x07\\x1b[31mRED');
    expect(r.stdout).toContain('\\x9b2J');
  });

  it('shows them as escapes in a validation failure and a response too', async () => {
    const failed = await hmc(['invoke', `${base}/escapes`, `urn:e${ESC}`]);
    expect(failed.code).toBe(2);
    expect(failed.stderr).toContain('shorter than minLength');
    expect(failed.stdout + failed.stderr).not.toMatch(CONTROL);
    const sent = await hmc(['invoke', `${base}/escapes`, `urn:b${ESC}`]);
    expect(sent.code, sent.stderr).toBe(0);
    expect(sent.stdout).toContain('body\\x1b]0;');
    expect(sent.stdout + sent.stderr).not.toMatch(CONTROL);
    // --json output was already safe: JSON escapes every control character.
    const json = await hmc(['list', `${base}/escapes`, '--json']);
    expect(json.stdout).not.toMatch(CONTROL);
    expect((JSON.parse(json.stdout) as { title: string }).title).toBe(`Title${ESC}`);
  });

  it('shows them as escapes in an error message', async () => {
    const r = await hmc(['describe', `${base}/escapes`, `urn:none${ESC}`]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('No control matching');
    expect(r.stdout + r.stderr).not.toMatch(CONTROL);
  });
});

type Request = { url: string | null; method: string; transport: string; body: unknown; headers: Record<string, string>; notes: string[];
  mcp: { arguments: { action_iri: string } } | null };
/** A dry run of `rel` in the document at `path` with `fields` (a list is the field repeated); its plan or its failure. */
async function dry(path: string, rel: string, fields: Record<string, string | string[]> = {}) {
  const args = Object.entries(fields).flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).flatMap(one => ['--field', `${k}=${one}`]));
  const r = await hmc(['invoke', `${base}${path}`, rel, ...args, '--dry-run', '--json']);
  return { r, request: r.code === 0 ? (JSON.parse(r.stdout) as { request: Request }).request : null };
}
// `list --json` writes each distinct field once, in fields, each sh:in list once, in inLists, and
// each list of fields once, in fieldLists, as places in fields; each control names its own list's
// place as fieldList, or null for a control that is not invoked, whose fields are not given, and,
// as templateFields, the place of the list of its template's variables that follow its own fields,
// which the controls that share the template share.
type ListedField = { name: string; required: boolean; multi: boolean; in: number | null; empty: string | null; description: string | null };
type Listed = { title: string; seeAlso: string[]; fields: ListedField[]; inLists: unknown[][]; fieldLists: number[][];
  controls: Array<{ rel: string; title: string; method: string; unsafe: boolean; target: string | null;
  warning: string | null; problem: string | null; fieldList: number | null; templateFields: number | null; unlisted: boolean }> };
async function listed(path: string): Promise<Listed> {
  const r = await hmc(['list', `${base}${path}`, '--json']);
  expect(r.code, r.stderr).toBe(0);
  return JSON.parse(r.stdout) as Listed;
}
/** A control's fields as list --json gives them: its own list's, then its template's. */
const listedFields = (doc: Listed, control: Listed['controls'][number]) =>
  [...doc.fieldLists[control.fieldList!]!, ...(control.templateFields === null ? [] : doc.fieldLists[control.templateFields]!)].map(i => doc.fields[i]!);
const fieldsOf = (doc: Listed, title: string) => listedFields(doc, doc.controls.find(c => c.title === title)!).map(f => [f.name, f.required, f.multi]);

describe('hmc.py: JSON-LD read as jsonld.js reads it', () => {
  it('treats a GET the document marks destructive as unsafe, however the mark is written, and sends nothing unconfirmed', async () => {
    const doc = await listed('/hints');
    expect(Object.fromEntries(doc.controls.map(c => [c.title, c.unsafe]))).toEqual({
      'Purge cache': true, 'Late prefix': true, 'Own context': true, 'Bare annotations': true, 'Plain read': false });
    for (const rel of ['iep:purge', 'iep:late', 'iep:embedded', 'iep:mcp']) {
      const r = await hmc(['invoke', `${base}/hints`, rel]);
      expect(r.code, r.stderr).toBe(0);
      expect(r.stdout, rel).toContain('Dry run');
    }
    expect(seen.filter(s => s.startsWith('GET /purge'))).toEqual([]);
  });

  it('resolves relative IRIs against the address a redirect landed at, except after a 303', async () => {
    const doc = await listed('/dir');
    expect(doc.controls.map(c => c.target)).toEqual([`${base}/dir/items`, `${base}/dir/items`]);
    const r = await hmc(['invoke', `${base}/dir`, 'iep:create', '--field', 'name=x', '--confirm']);
    expect(r.code, r.stderr).toBe(0);
    expect(seen).toContain('POST /dir/items');
    expect(seen).not.toContain('POST /items');
    expect((await listed('/see-other')).controls.map(c => c.target)).toEqual([`${base}/api`]);
  });

  it.each([
    ['/alias', 'iep:aliasSearch', { q: '5' }, '?q=5'], ['/alias-graph', 'iep:aliasGraph', {}, ''], ['/typeonly', 'iep:typeOnly', { n: '5' }, '?n=5'],
    ['/named-graph', 'iep:named', {}, ''], ['/included', 'iep:included', {}, ''], ['/index-map', 'iep:indexMap', {}, ''], ['/id-map', 'iep:idMap', {}, ''],
  ])('reads %s: keyword aliases, type-only terms, named graphs, @included and container maps', async (path, rel, fields, query) => {
    const { r, request } = await dry(path, rel, fields);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect([request!.transport, request!.url]).toEqual(['http', `${base}/api${query}`]);
  });

  it('types a field by a shape its keyword-aliased or type-only reference names', async () => {
    for (const [path, rel, name] of [['/alias', 'iep:aliasSearch', 'q'], ['/typeonly', 'iep:typeOnly', 'n']]) {
      const { r } = await dry(path!, rel!, { [name!]: '1.5' });
      expect(r.code, path).toBe(2);
      expect(r.stderr, path).toContain(`${name}: not an integer`);
    }
  });

  it('reads a JSON Schema given as a JSON literal value object', async () => {
    const bad = await dry('/json-value', 'iep:jsonValue', { count: '1.5' });
    expect(bad.r.code).toBe(2);
    expect(bad.r.stderr).toContain("missing required field 'name'");
    expect(bad.r.stderr).toContain('count: not an integer');
    expect((await dry('/json-value', 'iep:jsonValue', { name: 'a', count: '2' })).request!.body).toEqual({ name: 'a', count: 2 });
  });

  it('expands an action under "@vocab": "#" and a vocabulary term as the document defines it, as the page does', async () => {
    const cases: Array<[string, string, string]> = [
      ['/vocab-hash', 'publish', `${base}/vocab-hash#publish`],
      ['/actions', 'https://vocab.example/actions#search', 'https://vocab.example/actions#search'],
      ['/actions', 'https://vocab.example/actions#comment', 'https://vocab.example/actions#comment'],
      ['/actions', 'urn:example:action:lookup', 'urn:example:action:lookup'],
    ];
    for (const [path, rel, action] of cases) {
      const { r, request } = await dry(path, rel);
      expect(r.code, `${rel}: ${r.stderr}`).toBe(0);
      expect(request!.mcp!.arguments.action_iri, rel).toBe(action);
    }
  });

  it('takes a flattened document\'s title and links from the node at its address, not the first node', async () => {
    const doc = await listed('/flat');
    expect([doc.title, doc.seeAlso]).toEqual(['Glossary catalog', [`${base}/next`]]);
  });

  it('lists operations under hydra:operation, and warns when the class one expects is not described', async () => {
    const doc = await listed('/events');
    expect(doc.controls.map(c => [c.title, c.method])).toEqual([['Create event', 'POST']]);
    expect(doc.controls[0]!.warning).toContain('hydra:expects names https://vocab.example/Event, which this document does not describe');
  });

  it('reads a node object under @set, @list or @graph as that node, and unpacks only @index, @id and @type maps', async () => {
    const doc = await listed('/containers');
    expect(Object.fromEntries(doc.controls.map(c => [c.title, [c.method, c.target]])))
      .toEqual(Object.fromEntries(CONTAINER_READS.map(([, title]) => [title, ['GET', `${base}/api`]])));
    for (const [rel, title] of CONTAINER_READS) {
      const control = doc.controls.find(c => c.title === title)!;
      // Under @graph an @id map's key is the graph's IRI, and @none is no IRI, so neither names a node.
      if (!rel) {
        expect(control.rel, title).toMatch(/^_:/);
        continue;
      }
      expect(control.rel, title).toBe(rel);
      const { r, request } = await dry('/containers', rel);
      expect(r.code, `${rel}: ${r.stderr}`).toBe(0);
      expect([request!.transport, request!.url], rel).toEqual(['http', `${base}/api`]);
    }
  });
});

describe('hmc.py: scoped contexts, map references and repeated keys as jsonld.js reads them', () => {
  it('reads each control as jsonld.js gives it, as the page does', async () => {
    for (const [path, rel, title, method, url] of jsonldPlans(base)) {
      const doc = await listed(path);
      const control = doc.controls.find(c => c.rel === rel);
      expect(control, `${path} ${rel}: ${doc.controls.map(c => c.rel).join(', ')}`).toBeDefined();
      expect([control!.title, control!.problem], rel).toEqual([title, null]);
      const { r, request } = await dry(path, rel);
      expect(r.code, `${rel}: ${r.stderr}`).toBe(0);
      expect([request!.method, request!.transport, request!.url], rel).toEqual([method, url ? 'http' : 'mcp', url]);
    }
  });

  it('lists a control whose requests it cannot tell apart as unsafe, and refuses it with a problem', async () => {
    for (const [path, rel, title, method, problem] of jsonldRefusals(base)) {
      const doc = await listed(path);
      const control = doc.controls.find(c => c.title === title);
      expect(control, title).toBeDefined();
      expect([control!.rel, control!.method, control!.unsafe, control!.problem], title).toEqual([rel, method, true, problem]);
      const before = seen.length;
      const r = await hmc(['invoke', `${base}${path}`, rel, '--confirm']);
      expect(r.code, title).toBe(2);
      expect(r.stderr, title).toContain(problem);
      expect(seen.slice(before).filter(line => !line.startsWith(`GET ${path}`)), title).toEqual([]);
    }
    // Two python3 processes for each of some 70 controls, one after another: 17 to 21 s here, so
    // this test states its own budget rather than the suite's 20 s.
  }, 60_000);

  it('reads a JSON Schema with an "@id" under a "type" alias as JSON Schema, numbers and array counts included', async () => {
    expect((await dry('/schema-alias', 'urn:schema:alias', { n: '3', tags: '["a","b"]' })).request!.body).toEqual({ n: 3, tags: ['a', 'b'] });
    const bad = await dry('/schema-alias', 'urn:schema:alias', { n: '9', tags: '[1]' });
    expect(bad.r.code).toBe(2);
    expect(bad.r.stderr).toContain('tags: needs at least 2 values, got 1');
    expect(bad.r.stderr).toContain('n: above maxInclusive 5');
  });

  it('passes a percent-encoded triplet through a reserved expansion as it is', async () => {
    expect((await dry('/tmpl-pct', 'urn:tmpl:pct', { path: '/x?y=%2F&z=a b' })).request!.url).toBe(`${base}/r/x?y=%2F&z=a%20b`);
  });
});

describe('hmc.py: every value read, or the control or document refused', () => {
  it('reads every hint value: a GET marked unsafe in any of them is a dry run, and true with false is refused', async () => {
    const doc = await listed('/hint-values');
    expect(Object.fromEntries(doc.controls.map(c => [c.title, c.unsafe]))).toEqual({ 'Two hints': true, 'Merged hint': true,
      'Listed hint': true, 'Typed hint': true, 'String hint': true, 'Unreadable hint': true, 'Plain hint read': false });
    for (const rel of ['urn:hint:typed', 'urn:hint:string', 'urn:hint:unread']) {
      const r = await hmc(['invoke', `${base}/hint-values`, rel]);
      expect(r.code, r.stderr).toBe(0);
      expect(r.stdout, rel).toContain('Dry run');
    }
    expect(seen.filter(s => s.startsWith('GET /purge'))).toEqual([]);
  });

  it('reads an input of a shape whose properties and counts are written as @set objects', async () => {
    expect((await dry('/set-values', 'urn:set:shape', { q: '5' })).request!.url).toBe(`${base}/api?q=5`);
    const bad = await dry('/set-values', 'urn:set:shape', { q: '1.5' });
    expect([bad.r.code, bad.r.stderr]).toEqual([2, expect.stringContaining('Validation failed')]);
  });

  it('refuses a document whole when it uses a structure it does not read, with a problem that names it, and sends nothing', async () => {
    for (const [path, problem] of DOCUMENT_REFUSALS) {
      const before = seen.length;
      const r = await hmc(['list', `${base}${path}`]);
      expect([r.code, r.stderr.trim()], path).toEqual([1, `error: ${problem}`]);
      expect(seen.slice(before).filter(line => !line.startsWith(`GET ${path}`)), path).toEqual([]);
    }
    const nan = await hmc(['list', `${base}/not-json`]);
    expect([nan.code, nan.stderr.trim()]).toEqual([1, 'error: This document writes NaN, which is not JSON, so it is not read.']);
  });

  it('refuses a name two controls share, and values given under two names of one input', async () => {
    const before = seen.length;
    const r = await hmc(['invoke', `${base}/same-names`, 'remove', '--confirm']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("More than one control matches 'remove': urn:a:remove, urn:b:remove. Name one by its full IRI; nothing was sent.");
    expect(seen.slice(before).filter(line => !line.startsWith('GET /same-names'))).toEqual([]);
    expect((await dry('/same-names', 'urn:a:remove')).request!.url).toBe(`${base}/api`);
    const both = await dry('/same-names', 'urn:same:write', { q: '1', query: '2' });
    expect(both.r.code).toBe(2);
    expect(both.r.stderr).toContain('q: values were given under more than one of its names (q, query)');
  });

  it('refuses a HyperMarkdown block that gives its method twice, shows a title given twice as the last, and reads a hint', async () => {
    const doc = await listed('/hm-repeat');
    expect(Object.fromEntries(doc.controls.map(c => [c.title, [c.method, c.unsafe]]))).toEqual({
      'Repeated method': ['DELETE', true], 'Second title': ['GET', false], 'Destructive read': ['GET', true] });
    const r = await hmc(['invoke', `${base}/hm-repeat`, 'hm-destructive']);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('Dry run');
    expect(seen.filter(s => s.startsWith('GET /purge'))).toEqual([]);
  });

  it('lists every control a document gives, nested, blank or typed as something else too, and no others', async () => {
    for (const [path, titles] of LISTED) {
      expect((await listed(path)).controls.map(c => c.title).sort(), path).toEqual([...titles]);
    }
  });

  it('lists a control the document marks unsafe, wherever it says so, and sends nothing unconfirmed', async () => {
    for (const [path, rel, title, method] of UNSAFE_CONTROLS) {
      const control = (await listed(path)).controls.find(c => c.title === title);
      expect(control, title).toBeDefined();
      expect([control!.method, control!.unsafe, control!.problem], title).toEqual([method, true, null]);
      if (!rel) continue;
      const before = seen.length;
      const r = await hmc(['invoke', `${base}${path}`, rel]);
      expect(r.code, `${title}: ${r.stderr}`).toBe(0);
      expect(r.stdout, title).toContain('Dry run');
      expect(seen.slice(before).filter(line => !line.startsWith(`GET ${path}`)), title).toEqual([]);
    }
  });

  it('plans the same request, or stops at the same error, as the page', async () => {
    for (const [path, rel, fields, outcome] of dryRuns(base)) {
      const { r, request } = await dry(path, rel, fields);
      if ('error' in outcome) {
        expect(r.code, `${rel}: ${r.stdout}`).toBe(2);
        expect(problems(r.stderr), rel).toContain(outcome.error);
      } else {
        expect(r.code, `${rel}: ${r.stderr}`).toBe(0);
        expect([request!.url, request!.body], rel).toEqual([outcome.url, outcome.body]);
      }
    }
  });

  it('checks and plans each --field value as it was given, as the page does a link\'s, never as a form would change it', async () => {
    for (const [path, rel, fields, outcome] of LINK_CASES) {
      const { r, request } = await dry(path, rel, fields);
      const given = JSON.stringify(fields);
      if ('error' in outcome) {
        expect(r.code, `${given}: ${r.stdout}`).toBe(2);
        expect(problems(r.stderr), given).toContain(outcome.error);
      } else {
        expect(r.code, `${given}: ${r.stderr}`).toBe(0);
        expect(request!.body, given).toEqual(outcome.body);
      }
    }
  });

  it('keeps every repeated query parameter when it asks again for JSON-LD', async () => {
    await hmc(['list', `${base}/fmt?tag=a&tag=b&format2=x`]);
    expect(seen).toContain('GET /fmt?tag=a&tag=b&format2=x&format=jsonld');
  });
});

describe('hmc.py: templates and transport', () => {
  it('resolves a relative IRI template against the base, and applies a prefix modifier', async () => {
    const r = await hmc(['list', `${base}/tmpl/desc`]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).not.toContain('unknown');
    const cases: Array<[string, string, Record<string, string>, string]> = [
      ['/tmpl/desc', 'iep:relSearch', { q: 'x' }, `${base}/search?q=x`],
      ['/tmpl/desc', 'iep:relItems', { id: '7', limit: '3' }, `${base}/tmpl/items/7?limit=3`],
      ['/tmpl/desc', 'iep:prefixShard', { id: 'abcdef' }, `${base}/tmpl/shard/ab/abcdef`],
      ['/tmpl-base', 'iep:baseItems', { q: 'x' }, 'https://api.example/v1/items?q=x'],
    ];
    for (const [path, rel, fields, url] of cases) {
      const { r: run, request } = await dry(path, rel, fields);
      expect(run.code, `${rel}: ${run.stderr}`).toBe(0);
      expect(request!.url, rel).toBe(url);
    }
    const live = await hmc(['invoke', `${base}/tmpl/desc`, 'iep:relSearch', '--field', 'q=x']);
    expect(live.code, live.stderr).toBe(0);
    expect(seen).toContain('GET /search?q=x');
  });

  it('keeps a template mapping with no hydra:property as its own required field', async () => {
    const r = await hmc(['invoke', `${base}/mappings`, 'urn:delete-item', '--field', 'force=true', '--confirm']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("missing required field 'id'");
    expect((await dry('/mappings', 'urn:delete-item', { id: '7', force: 'true' })).request!.url).toBe(`${base}/items/7?force=true`);
  });

  it('sends a hydra:target that is an IRI template as a template', async () => {
    const r = await hmc(['invoke', `${base}/target-template`, 'control-about', '--field', `endpoint=${base}/lrs`]);
    expect(r.code, r.stderr).toBe(0);
    expect(seen).toContain('GET /lrs/about');
  });

  it('sends a safe method\'s whole-body field as a parameter and labels a body by its own type', async () => {
    const query = 'SELECT * WHERE { ?s ?p ?o } LIMIT 1';
    const r = await hmc(['invoke', `${base}/raw`, 'iep:sparqlGet', '--field', `query=${query}`]);
    expect(r.code, r.stderr).toBe(0);
    const got = received.filter(x => x.line.startsWith('GET /sparql?'));
    expect(got.length).toBeGreaterThan(0);
    expect(new URL(got[0]!.line.slice(4), base).searchParams.get('query')).toBe(query);
    expect([got[0]!.body, got[0]!.type]).toEqual(['', '']);
    const post = await dry('/raw', 'iep:sparqlPost', { query });
    expect([post.request!.headers['Accept'], post.request!.headers['Content-Type'], post.request!.body])
      .toEqual(['application/sparql-results+json', 'application/sparql-query', query]);
    const put = await dry('/raw', 'iep:notePut', { body: 'hello' });
    expect([put.request!.headers['Accept'], put.request!.headers['Content-Type']]).toEqual(['text/turtle', 'text/plain']);
  });

  it('treats a control with no method as a POST, so it sends nothing unconfirmed', async () => {
    const doc = await listed('/no-method');
    expect(doc.controls.map(c => [c.method, c.unsafe])).toEqual([['POST', true]]);
    const r = await hmc(['invoke', `${base}/no-method`, 'urn:publish-note']);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('Dry run');
    expect(seen.filter(s => s.includes('/publish'))).toEqual([]);
  });

  it('writes the same URL as the page for a non-ASCII path, a replaced query parameter and number fields', async () => {
    const wiki = await hmc(['invoke', `${base}/wiki`, 'urn:wiki']);
    expect(wiki.code, wiki.stderr).toBe(0);
    expect(seen).toContain('GET /wiki/Caf%C3%A9');
    expect((await dry('/merge', 'urn:merge', { tag: '["a","b"]', view: 'brief' })).request!.url).toBe(`${base}/items?tag=a&tag=b&view=brief`);
    expect((await dry('/rates', 'urn:rates', { amount: '2', lat: '0.0000001', big: '1e16' })).request!.url)
      .toBe(`${base}/rates/2?lat=1e-7&big=10000000000000000`);
  });
});

describe('hmc.py: forms', () => {
  it('takes a list for a property with no sh:maxCount, checks its count, and sends it as a JSON array', async () => {
    const doc = await listed('/multi');
    expect(fieldsOf(doc, 'Publish classified')).toEqual([['graph_iri', true, false], ['conforms_to_shapes', true, true],
      ['tags', true, true], ['levels', false, true]]);
    const g = `${base}/g`;
    const few = await dry('/multi', 'urn:act-publish', { graph_iri: g, tags: 'a' });
    expect(few.r.stderr).toContain('tags: needs at least 2 values, got 1');
    const many = await dry('/multi', 'urn:act-publish', { graph_iri: g, tags: ['a', 'b', 'c', 'd', 'e', 'f'] });
    expect(many.r.stderr).toContain('tags: takes at most 5 values, got 6');
    const wrong = await dry('/multi', 'urn:act-publish', { graph_iri: g, tags: ['a', 'b'], levels: '4' });
    expect(wrong.r.stderr).toContain('levels: must be one of 1, 2, 3');
    for (const tags of [['a', 'b'], 'a\nb', '["a","b"]']) {
      const ok = await dry('/multi', 'urn:act-publish', { graph_iri: g, tags, levels: ['1', '3'] });
      expect(ok.r.code, ok.r.stderr).toBe(0);
      expect(ok.request!.body).toEqual({ graph_iri: g, conforms_to_shapes: [`${base}/shapes`], tags: ['a', 'b'], levels: [1, 3] });
    }
  });

  it('checks a JSON array\'s count against sh:minCount and sh:maxCount or minItems and maxItems, on a dry run and a confirmed write', async () => {
    const sent = () => seen.filter(s => s.startsWith('POST /num-target')).length;
    const before = sent();
    for (const [path, rel, , fields, message] of countCases(base)) {
      const args = Object.entries(fields).flatMap(([k, v]) => ['--field', `${k}=${v}`]);
      for (const mode of ['--dry-run', '--confirm']) {
        const r = await hmc(['invoke', `${base}${path}`, rel, ...args, mode]);
        expect(r.code, `${rel} ${JSON.stringify(fields)} ${mode}: ${r.stdout}${r.stderr}`).toBe(2);
        expect(r.stderr, `${rel} ${JSON.stringify(fields)} ${mode}`).toContain('Validation failed');
        expect(r.stderr, `${rel} ${JSON.stringify(fields)} ${mode}`).toContain(message);
      }
    }
    expect(sent()).toBe(before);
    // Within its bounds each array is sent as written, and a field that takes one object takes one.
    const nodes = { members: '[{},{"a":1}]', notes: '[{}]', owner: '{"name":"o"}' };
    const ok = await dry('/counts', 'urn:count-nodes', nodes);
    expect(ok.r.code, ok.r.stderr).toBe(0);
    expect(ok.request!.body).toEqual({ members: [{}, { a: 1 }], notes: [{}], owner: { name: 'o' } });
    const live = await hmc(['invoke', `${base}/counts`, 'urn:count-nodes',
      ...Object.entries(nodes).flatMap(([k, v]) => ['--field', `${k}=${v}`]), '--confirm']);
    expect(live.code, live.stderr).toBe(0);
    expect(sent()).toBe(before + 1);
    const items = await dry('/counts', 'urn:count-items', { tags: '["a","b","c"]', extra: '{"a":[1,2]}' });
    expect(items.r.code, items.r.stderr).toBe(0);
    expect(items.request!.body).toEqual({ tags: ['a', 'b', 'c'], extra: { a: [1, 2] } });
  });

  it('builds fields from hydra:supportedProperty, by property IRI and by an inline property\'s label', async () => {
    expect(fieldsOf(await listed('/apidoc'), 'Post a comment')).toEqual([['text', true, false], ['author', false, false]]);
    expect((await dry('/apidoc', 'post-comment', { text: 'hello' })).request!.body).toEqual({ text: 'hello' });
    expect((await dry('/apidoc', 'post-comment')).r.stderr).toContain("missing required field 'text'");
    expect(fieldsOf(await listed('/manifest'), 'Create note').map(f => f[0])).toEqual(['title', 'priority', 'kind']);
    expect((await dry('/manifest', 'urn:create-note', { title: 'x', kind: 'memo', priority: '9' })).r.stderr).toContain('priority: above maxInclusive 5');
  });

  it('matches a template mapping\'s compact hydra:property to the shape\'s path, so one field carries the shape\'s limits', async () => {
    expect(fieldsOf(await listed('/mapprop'), 'Find').map(f => f[0])).toEqual(['text']);
    expect((await dry('/mapprop', 'iep:find', { text: 'abcdefgh' })).r.stderr).toContain('text: longer than maxLength 5');
  });

  it('names a field from a relative path with non-ASCII characters as written, as the page does', async () => {
    expect((await dry('/fiche', 'urn:fiche', { 'prénom': 'Ada', 'âge': '36' })).request!.body).toEqual({ 'prénom': 'Ada', 'âge': 36 });
  });

  it('refuses a control with two fields of one name, and a field name no input has', async () => {
    const dup = await dry('/dup', 'urn:dup', { description: 'A dataset' });
    expect(dup.r.code).toBe(2);
    expect(dup.r.stderr).toContain("two input fields are both named 'description'");
    const unknown = await dry('/bool-enum', 'urn:accept', { agree: 'true', nope: '1' });
    expect(unknown.r.code).toBe(2);
    expect(unknown.r.stderr).toContain("no input field is named 'nope'");
  });

  it('sends a JSON boolean or object enum entry named by its JSON text as the entry itself, and reads a count facet written 1.0', async () => {
    const accepted = await dry('/bool-enum', 'urn:accept', { agree: 'true', mode: '{"a":1}' });
    expect(accepted.r.code, accepted.r.stderr).toBe(0);
    expect(accepted.request!.body).toEqual({ agree: true, mode: { a: 1 } });
    expect((await dry('/mincount', 'urn:mincount', { a: 'toolong' })).r.stderr).toContain('a: longer than maxLength 3');
    expect((await dry('/mincount', 'urn:mincount')).r.stderr).toContain("missing required field 'a'");
  });
});

describe('hmc.py: the address sent is the address printed', () => {
  it('prints the exact address it sends to, as the page\'s URL parser writes it, and sends it there', async () => {
    // "%2e%2e" is "..", so this goes to /admin, and the dry run says so.
    expect((await dry('/sent', 'urn:sent-dots')).request!.url).toBe(`${base}/admin`);
    const dots = await hmc(['invoke', `${base}/sent`, 'urn:sent-dots']);
    expect(dots.code, dots.stderr).toBe(0);
    expect(dots.stdout).toContain(`GET ${base}/admin\n`);
    expect(seen).toContain('GET /admin');
    // An upper-case scheme is http(s) too; the host is lower-cased, the default port, the dot
    // segments and the fragment dropped, and the quotes encoded, as the page writes it.
    const canon = (await dry('/sent', 'urn:sent-canon')).request!;
    expect([canon.transport, canon.url]).toEqual(['http', 'https://good.example/A/c?x=%22y%22&z=%27w%27']);
    // The query is written as the page's URLSearchParams writes it: "~" encoded, "*" not.
    expect((await dry('/sent', 'urn:sent-query', { a: '~*x y' })).request!.url).toBe(`${base}/q?keep=a+b&a=%7E*x+y`);
    const query = await hmc(['invoke', `${base}/sent`, 'urn:sent-query', '--field', 'a=~*x y']);
    expect(query.code, query.stderr).toBe(0);
    expect(seen).toContain('GET /q?keep=a+b&a=%7E*x+y');
    // An address it does not send is printed in its URI form, as the page shows it, port and all.
    const v6 = (await dry('/sent', 'urn:sent-v6')).request!;
    expect([v6.transport, v6.url]).toEqual(['unknown', 'ftp://%C3%BCser@[::1]:8443/x']);
  });

  it.each([
    ['urn:sent-backslash', { q: 'secret' }, 'the address holds a backslash, a space or a control character'],
    ['urn:sent-plus', { u: '@evil.example/x' }, 'the address does not name its host after "//"'],
    ['urn:sent-user', {}, 'the address carries user information before its host'],
    ['urn:sent-number', {}, "the address's host is a number written other than as four decimal parts"],
    ['urn:sent-tab', {}, 'the address holds a backslash, a space or a control character'],
    // "xn--a" is no punycode a URL parser accepts, so the page refuses it too.
    ['urn:sent-punycode', {}, 'the address is not a URL'],
    // IDNA 2003 maps "ß" to "ss", so this would go to strasse.example, where the page goes to
    // xn--strae-oqa.example; hmc.py refuses it rather than send to another domain.
    ['urn:sent-sharp-s', {}, 'hmc.py does not send to a host with ß, ς, ZWJ or ZWNJ'],
  ])('refuses %s, an address it cannot send as written, before anything is sent', async (rel, fields, message) => {
    const before = seen.length;
    const { r } = await dry('/sent', rel, fields);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(message);
    expect(seen.slice(before).filter(line => line !== 'GET /sent')).toEqual([]);
  });
});

describe('hmc.py: values a request can carry, and lengths in code points', () => {
  const sentTo = () => seen.filter(s => / \/num-target(\?|$)/.test(s)).length;

  it.each([...VALUE_CASES, ...CHOICE_CASES, ...SWEEP_CASES, ...RULE_CASES, ...EMPTY_CASES])('reads %s %s (%s) as the page does: case %#', async (path, rel, _title, fields, outcome) => {
    if ('body' in outcome) {
      const { r, request } = await dry(path, rel, fields);
      expect(r.code, r.stderr).toBe(0);
      expect(request!.body).toEqual(outcome.body);
      return;
    }
    const before = sentTo();
    const args = Object.entries(fields).flatMap(([k, v]) => ['--field', `${k}=${v}`]);
    for (const mode of ['--dry-run', '--confirm']) {
      const r = await hmc(['invoke', `${base}${path}`, rel, ...args, mode]);
      expect(r.code, `${mode}: ${r.stdout}${r.stderr}`).toBe(2);
      expect(r.stderr, mode).toContain('Validation failed');
      if ('only' in outcome) expect(problems(r.stderr), mode).toEqual([outcome.error]);
      else expect(problems(r.stderr), mode).toContain(outcome.error);
    }
    expect(sentTo()).toBe(before);
  });

  it.each(BODY_TEXTS)('sends %s %s (%s) as the body the page sends, byte for byte: case %#', async (path, rel, _title, fields, body) => {
    const args = Object.entries(fields).flatMap(([k, v]) => ['--field', `${k}=${v}`]);
    const before = received.length;
    const r = await hmc(['invoke', `${base}${path}`, rel, ...args, '--confirm']);
    expect(r.code, r.stderr).toBe(0);
    const posted = received.slice(before).filter(one => one.line === 'POST /num-target');
    expect(posted.map(one => one.body)).toEqual([body]);
  });

  it('refuses NaN or an infinity handed to resolve_plan or invoke_plan unchecked, and sends nothing', async () => {
    const before = sentTo();
    // hmc.py as a library, given values validate_fields would have refused.
    const script = [
      'import json, sys', 'sys.dont_write_bytecode = True', 'sys.path.insert(0, sys.argv[1])', 'import hmc',
      'url = sys.argv[2]', 'd = hmc.parse_descriptor(sys.stdin.read(), "application/ld+json", url)',
      'control = next(c for c in d.controls if c.rel == "urn:values:object")', 'out = []',
      'try:', '    hmc.resolve_plan(control, {"document": {"score": float("nan")}}, url)', '    out.append("planned")',
      'except hmc.UnsendableValue as exc:', '    out.append(str(exc))',
      'plan = hmc.resolve_plan(control, {"document": {"score": 1}}, url)',
      'plan.body, plan.body_text = {"document": {"score": float("inf")}}, None',
      'try:', '    hmc.invoke_plan(plan, confirm=True)', '    out.append("sent")',
      'except hmc.UnsendableValue as exc:', '    out.append(str(exc))', 'print(json.dumps(out))'].join('\n');
    const r = await new Promise<{ code: number | null; stdout: string; stderr: string }>(resolve => {
      const child = spawn(PYTHON, ['-I', '-c', script, dirname(HMC), `${base}/values`],
        { env: { PATH: process.env['PATH'] || '', LANG: 'C.UTF-8', NO_PROXY: '*', no_proxy: '*' } });
      let stdout = ''; let stderr = '';
      child.stdout.setEncoding('utf8').on('data', d => { stdout += d; });
      child.stderr.setEncoding('utf8').on('data', d => { stderr += d; });
      child.on('close', code => resolve({ code, stdout, stderr }));
      child.stdin.end(sharedDescriptors(base)['/values']);
    });
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(['document: holds NaN or an infinity, which is not JSON, so nothing is sent',
      'a value holds NaN or an infinity, which is not JSON, so nothing is sent']);
    expect(sentTo()).toBe(before);
  });

  it('writes --json output as JSON: a number past a double as null, as JSON.stringify does, and a NaN response as its text', async () => {
    const d = await hmc(['describe', `${base}/values`, 'urn:values:default']);
    expect(d.code, d.stderr).toBe(0);
    expect((JSON.parse(d.stdout) as { fields: Array<{ defaultValue: unknown }> }).fields[0]!.defaultValue).toEqual({ score: null });
    const nan = await hmc(['invoke', `${base}/odd-bodies`, 'urn:odd-nan', '--json']);
    expect(nan.code, nan.stderr).toBe(0);
    expect((JSON.parse(nan.stdout) as { response: unknown }).response).toMatchObject({ body: null, bodyText: '{"score":NaN}' });
    const large = await hmc(['invoke', `${base}/odd-bodies`, 'urn:odd-large', '--json']);
    expect(large.code, large.stderr).toBe(0);
    expect((JSON.parse(large.stdout) as { response: unknown }).response).toMatchObject({ body: { score: null }, bodyText: '{"score":1e400}' });
    // Shown as text, each is what the page shows: NaN as received, and the large number as null.
    expect((await hmc(['invoke', `${base}/odd-bodies`, 'urn:odd-nan'])).stdout).toContain('{"score":NaN}');
    expect((await hmc(['invoke', `${base}/odd-bodies`, 'urn:odd-large'])).stdout).toContain('"score": null');
  });
});

describe('hmc.py: warnings and dates', () => {
  it.each(WARNING_CASES)('describes %s %s (%s) with the warning the page shows', async (path, rel, _title, warning) => {
    const r = await hmc(['describe', `${base}${path}`, rel]);
    expect(r.code, r.stderr).toBe(0);
    expect((JSON.parse(r.stdout) as { warning: string | null }).warning).toBe(warning);
  });

  it('checks each date and time as XSD 1.1 writes it, as the page does', async () => {
    // hmc.py as a library: every case through validate_fields in one process.
    const script = [
      'import json, sys', 'sys.dont_write_bytecode = True', 'sys.path.insert(0, sys.argv[1])', 'import hmc',
      'url = sys.argv[2]', 'data = json.loads(sys.stdin.read())', 'd = hmc.parse_descriptor(data["doc"], "application/ld+json", url)',
      'control = next(c for c in d.controls if c.rel == "urn:temporal")', 'out = []',
      'for kind, text in data["cases"]:', '    values, errors = hmc.validate_fields(control, {kind: text})', '    out.append([values, errors])',
      'print(json.dumps(out))'].join('\n');
    const r = await new Promise<{ code: number | null; stdout: string; stderr: string }>(resolve => {
      const child = spawn(PYTHON, ['-I', '-c', script, dirname(HMC), `${base}/temporal`],
        { env: { PATH: process.env['PATH'] || '', LANG: 'C.UTF-8', NO_PROXY: '*', no_proxy: '*' } });
      let stdout = ''; let stderr = '';
      child.stdout.setEncoding('utf8').on('data', d => { stdout += d; });
      child.stderr.setEncoding('utf8').on('data', d => { stderr += d; });
      child.on('close', code => resolve({ code, stdout, stderr }));
      child.stdin.end(JSON.stringify({ doc: sharedDescriptors(base)['/temporal'], cases: TEMPORAL_CASES.map(([kind, text]) => [kind, text]) }));
    });
    expect(r.code, r.stderr).toBe(0);
    const results = JSON.parse(r.stdout) as Array<[Record<string, unknown>, string[]]>;
    TEMPORAL_CASES.forEach(([kind, text, ok], i) => {
      const [values, errors] = results[i]!;
      if (ok) expect([values, errors], `${kind} ${JSON.stringify(text)}`).toEqual([{ [kind]: text }, []]);
      else expect(errors, `${kind} ${JSON.stringify(text)}`).toEqual(text === '' ? [] : [`${kind}: not an xsd:${kind}`]);
    });
  });
});

describe('hmc.py: template mappings', () => {
  it('makes one field of two mappings of one variable, and of a renaming mapping and a bare one, as the page does', async () => {
    for (const rel of ['urn:twin-variable', 'urn:twin-renamed']) {
      const { r, request } = await dry('/twin-mappings', rel, { q: 'v' });
      expect(r.code, `${rel}: ${r.stderr}`).toBe(0);
      expect(request!.url, rel).toBe(`${base}/s?q=v`);
    }
    expect(fieldsOf(await listed('/twin-mappings'), 'Renamed then bare')).toEqual([['q', false, false]]);
  });
});

describe('hmc.py: a document\'s size, not its shape, sets the cost', () => {
  it.each(COST_CASES)('describes and dry-runs %s\'s control %s within the budget', async (path, rel, _controls, fields, refused) => {
    const r = await hmc(['describe', `${base}${path}`, rel]);
    expect(r.timedOut, 'killed after 30 s').toBe(false);
    expect(r.ms, 'run time').toBeLessThan(3_000);
    expect(r.code, r.stderr).toBe(0);
    expect((JSON.parse(r.stdout) as { fields: unknown[] }).fields).toHaveLength(fields);
    const run = await hmc(['invoke', `${base}${path}`, rel, '--dry-run']);
    expect(run.timedOut, 'killed after 30 s').toBe(false);
    expect(run.ms, 'dry run time').toBeLessThan(3_000);
    if (refused) {
      expect(run.code, run.stdout).toBe(2);
      expect(problems(run.stderr)).toHaveLength(1);
      expect(problems(run.stderr)[0]!.startsWith(refused)).toBe(true);
    } else expect(run.code, run.stderr).toBe(0);
  }, 60_000);

  it.each(SHARED_COST_CASES)('refuses %s\'s control %s, whose inputs share one list of choices or one long text, within the budget', async (path, rel, problem) => {
    const r = await hmc(['describe', `${base}${path}`, rel]);
    expect(r.timedOut, 'killed after 30 s').toBe(false);
    expect(r.ms, 'run time').toBeLessThan(3_000);
    expect(r.code, r.stderr).toBe(0);
    expect((JSON.parse(r.stdout) as { problem: string | null }).problem).toBe(problem);
    const run = await hmc(['invoke', `${base}${path}`, rel, '--dry-run']);
    expect(run.timedOut, 'killed after 30 s').toBe(false);
    expect(run.ms, 'dry run time').toBeLessThan(3_000);
    expect(run.code, run.stdout).toBe(2);
    expect(problems(run.stderr)).toEqual([problem]);
  }, 60_000);

  it('lists every control of a document whose controls share one shape within the budget, writing the shape\'s fields once', async () => {
    const r = await hmc(['list', `${base}/cost/shape`]);
    expect(r.timedOut, 'killed after 30 s').toBe(false);
    expect(r.ms, 'run time').toBeLessThan(3_000);
    expect(r.code, r.stderr).toBe(0);
    const lines = r.stdout.split('\n').filter(line => line.trim().startsWith('fields: '));
    expect(lines).toHaveLength(400);
    expect(lines[0]).toContain('fields: p0, p1, p2');
    expect(new Set(lines.slice(1))).toEqual(new Set(['         fields: as listed for urn:c0']));
    const json = await hmc(['list', `${base}/cost/shape`, '--json']);
    expect(json.code, json.stderr).toBe(0);
    const doc = JSON.parse(json.stdout) as Listed;
    expect(doc.fieldLists).toHaveLength(1);
    expect(doc.fieldLists[0]).toHaveLength(400);
    expect(new Set(doc.controls.map(c => c.fieldList))).toEqual(new Set([0]));
  }, 60_000);

  it('writes once the variables of a template many controls share, a field many shapes name and an sh:in list many fields name', async () => {
    const variables = Array.from({ length: 1000 }, (_, j) => `v${j}`).join(', ');
    // Controls whose own fields differ list the template's variables once and name it for the rest.
    const own = await hmc(['list', `${base}/cost/template-own`]);
    expect(own.code, own.stderr).toBe(0);
    const lines = own.stdout.split('\n').filter(line => line.trim().startsWith('fields: '));
    expect(lines).toHaveLength(1000);
    expect(lines[0]).toBe(`         fields: x0, ${variables}`);
    for (const line of lines.slice(1)) expect(line).toMatch(/^ {9}fields: x\d+, and the template's variables as listed for urn:c0$/);
    const ownJson = await listed('/cost/template-own');
    expect(new Set(ownJson.controls.map(c => c.templateFields)).size).toBe(1);
    expect(ownJson.fieldLists[ownJson.controls[0]!.templateFields!]).toHaveLength(1000);
    expect(ownJson.controls.map(c => ownJson.fieldLists[c.fieldList!]!.length)).toEqual(Array(1000).fill(1));
    expect(fieldsOf(ownJson, 'C7').map(f => f[0])).toEqual(['x7', ...variables.split(', ')]);
    // Controls whose fields are the same share them whole.
    const same = await hmc(['list', `${base}/cost/template-schemas`]);
    const sameLines = same.stdout.split('\n').filter(line => line.trim().startsWith('fields: '));
    expect(sameLines[0]).toBe(`         fields: x, ${variables}`);
    expect(new Set(sameLines.slice(1))).toEqual(new Set(['         fields: as listed for urn:c0']));
    // A property node 1,000 shapes name is one field, its long description written once.
    for (const path of ['/cost/property-shared', '/cost/property-shapes']) {
      const doc = await listed(path);
      expect(doc.fields.filter(f => f.name === 'm'), path).toHaveLength(1);
      expect(doc.fields.find(f => f.name === 'm')!.description, path).toHaveLength(100000);
      expect(new Set(doc.controls.map(c => c.fieldList)).size, path).toBe(1);
    }
    // Controls whose own fields a mapping matches, or whose schemas type the variables, each join the
    // template for themselves: list builds so many as the document's size allows, and lists the rest
    // without their fields, which describe builds.
    for (const path of ['/cost/template-matched', '/cost/template-typed']) {
      const text = await hmc(['list', `${base}${path}`]);
      const notes = text.stdout.split('\n').filter(line => line.includes("fields: not listed, since listing every control's would cost"));
      expect(notes.length, path).toBeGreaterThan(900);
      const doc = await listed(path);
      expect(doc.controls.filter(c => c.unlisted).map(c => [c.fieldList, c.problem]), path).toEqual(Array(notes.length).fill([null, null]));
    }
    // One RDF list that 1,000 fields name as their sh:in is written once.
    const lists = await listed('/cost/list-shared');
    expect(lists.inLists).toHaveLength(1);
    expect(lists.inLists[0]).toHaveLength(1000);
    expect(new Set(lists.fields.map(f => f.in))).toEqual(new Set([0]));
  }, 60_000);

  it.each(EXPANSION_CASES)('refuses %s, whose IRIs expand to far more text than it holds, whole and within the budget', async (path, rel) => {
    for (const args of [['list', `${base}${path}`], ['list', `${base}${path}`, '--json'], ['describe', `${base}${path}`, rel]]) {
      const r = await hmc(args);
      expect(r.timedOut, 'killed after 30 s').toBe(false);
      expect(r.ms, `${args[0]} ${args[2] || ''} run time`).toBeLessThan(3_000);
      expect([r.code, r.stderr.trim()], args.join(' ')).toEqual([1, `error: ${EXPANSION_PROBLEM}`]);
      expect(r.stdout).toBe('');
    }
  }, 60_000);

  // Turtle is read by rdflib, which expands its prefixed names and relative IRIs and builds a node
  // for each term as it parses, before hmc.py reads what it writes: what it would make is charged
  // first, so each is refused by name, with or without rdflib, sending nothing, in 512 MB.
  it.each(TURTLE_COST)('refuses the Turtle %s, which rdflib would make far more of than its size, before rdflib reads it', async (path, _text, problem) => {
    for (const args of [['list', `${base}${path}`], ['list', `${base}${path}`, '--json'], ['describe', `${base}${path}`, 'urn:c0']]) {
      const r = await hmc(args, 30_000, {}, 512);
      expect(r.timedOut, 'killed after 30 s').toBe(false);
      expect(r.ms, `${args[0]} ${args[2] || ''} run time`).toBeLessThan(3_000);
      expect([r.code, r.stderr.trim()], args.join(' ')).toEqual([1, `error: ${problem}`]);
      expect(r.stdout).toBe('');
    }
  }, 60_000);

  // What list, list --json and describe write grows with the document, never with the product of
  // two of its sizes: a field list many controls share is written once, a node a shape names many
  // times is one input, and a control that is not invoked has its problem written, not its fields.
  it.each(COST_CASES)('writes what it lists and describes of %s within a few times the document\'s size', async (path, rel) => {
    const size = Buffer.byteLength(cost[path]!);
    for (const args of [['list', `${base}${path}`], ['list', `${base}${path}`, '--json'], ['describe', `${base}${path}`, rel]]) {
      const r = await hmc(args);
      expect(r.timedOut, 'killed after 30 s').toBe(false);
      expect(r.ms, `${args[0]} ${args[2] || ''} run time`).toBeLessThan(3_000);
      expect(r.code, r.stderr).toBe(0);
      expect(Buffer.byteLength(r.stdout), `${args[0]} ${args[2] || ''} output`).toBeLessThan(OUTPUT_PER_BYTE * size + OUTPUT_SLACK);
    }
  }, 60_000);

  // Each step hmc.py takes for a document within the tests' budget, in 512 MB, writing a few times
  // its size; one past what its size allows is refused, naming it, and nothing is written or sent.
  it.each(WORK_CASES)('lists, describes and dry-runs %s\'s control %s within the budget, or refuses by name where it is past it', async (path, rel, refused, dryRun, sent) => {
    const size = Buffer.byteLength(cost[path]!);
    const problem = workProblem(size);
    const steps = [['list', ['list', `${base}${path}`]], ['list --json', ['list', `${base}${path}`, '--json']],
      ['control', ['describe', `${base}${path}`, rel]], ['request', ['invoke', `${base}${path}`, rel, '--dry-run']]] as const;
    for (const [step, args] of steps) {
      const r = await hmc([...args], 30_000, {}, 512);
      expect(r.timedOut, `${step}: killed after 30 s`).toBe(false);
      expect(r.ms, `${step} run time`).toBeLessThan(3_000);
      expect(Buffer.byteLength(r.stdout) + Buffer.byteLength(r.stderr), `${step} output`).toBeLessThan(OUTPUT_PER_BYTE * size + OUTPUT_SLACK);
      if (refused.includes('read') || (step.startsWith('list') && refused.includes(step))) {
        expect([r.code, r.stderr.trim()], step).toEqual([1, `error: ${problem}`]);
        expect(r.stdout, step).toBe('');
      } else if (step.startsWith('list')) {
        expect(r.code, `${step}: ${r.stderr}`).toBe(0);
      } else if (step === 'control') {
        expect(r.code, r.stderr).toBe(0);
        const control = JSON.parse(r.stdout) as { problem: string | null; fields: unknown[] | null };
        if (refused.includes('control')) expect([control.problem, control.fields]).toEqual([problem, null]);
        else if (dryRun) expect(control.problem!.startsWith(dryRun)).toBe(true);
        else expect(control.problem).toBeNull();
      } else if (refused.includes('control') || refused.includes('request')) {
        expect(r.code, r.stdout).toBe(2);
        expect(problems(r.stderr)).toEqual([refused.includes('control') ? problem : workProblem(size + Buffer.byteLength(JSON.stringify(sent)))]);
      } else if (dryRun) {
        expect(r.code, r.stdout).toBe(2);
        expect(problems(r.stderr)[0]!.startsWith(dryRun)).toBe(true);
      } else {
        expect(r.code, r.stderr).toBe(0);
        expect(r.stdout).toMatch(/^Dry run\b/m);
      }
    }
  }, 60_000);

  it('gives no fields for a control that is not invoked, in list --json and describe', async () => {
    const doc = await listed('/cost/shared-default');
    expect(doc.controls).toHaveLength(1);
    expect(doc.controls[0]!.problem).not.toBeNull();
    expect(doc.controls[0]!.fieldList).toBeNull();
    const d = await hmc(['describe', `${base}/cost/shared-default`, 'urn:shared-schema']);
    expect(d.code, d.stderr).toBe(0);
    expect((JSON.parse(d.stdout) as { fields: unknown }).fields).toBeNull();
    const text = await hmc(['list', `${base}/cost/shared-default`]);
    expect(text.stdout).not.toContain('fields: ');
  }, 60_000);
});
