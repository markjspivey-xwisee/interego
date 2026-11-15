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
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const HMC = fileURLToPath(new URL('../docs/hypermedia-client/hmc.py', import.meta.url));
const PYTHON = process.env['PYTHON'] || 'python3';

// About twice as slow per extra character when the pattern runs; 27 took far over the budget.
const SLOW_PATTERN = '^(a|a)*$';
const SLOW_DEFAULT = 'a'.repeat(27) + 'b';
// A field name that a backtracking `(?:rest-param-.+-)?(.+)$` retries at every position.
const LONG_NAME = 'rest-param-' + '-'.repeat(60_000) + '\nx';

let server: Server;
let base = '';
const seen: string[] = [];
// Terminal control sequences: a window title (OSC 0), colour (CSI), a clipboard write (OSC 52),
// a carriage return that would overwrite the line, and a C1 control.
const ESC = '\x1b]0;PWNED-TITLE\x07\x1b[31mRED\x1b[0m\x1b]52;c;cHduZWQ=\x07\r\x9b2J';
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/;
// A local file a descriptor must not be able to make hmc.py read.
const SECRET = 'HMC-LOCAL-FILE-SECRET';
let dir = '';
let secretUrl = '';

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
  };
}

interface Run { code: number | null; stdout: string; stderr: string; ms: number; timedOut: boolean }
/** Run hmc.py without blocking this process, which is also the server it talks to. */
function hmc(args: string[], timeoutMs = 30_000): Promise<Run> {
  return new Promise(resolve => {
    const started = Date.now();
    // A minimal environment: no proxy variables, so requests to 127.0.0.1 go straight there.
    const child = spawn(PYTHON, ['-I', HMC, ...args], { env: { PATH: process.env['PATH'] || '', LANG: 'C.UTF-8', NO_PROXY: '*', no_proxy: '*' } });
    let stdout = ''; let stderr = ''; let timedOut = false;
    child.stdout.setEncoding('utf8').on('data', d => { stdout += d; });
    child.stderr.setEncoding('utf8').on('data', d => { stderr += d; });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr, ms: Date.now() - started, timedOut }); });
  });
}

beforeAll(async () => {
  const probe = spawnSync(PYTHON, ['--version'], { encoding: 'utf8' });
  if (probe.status !== 0) throw new Error(`${PYTHON} is needed to test docs/hypermedia-client/hmc.py (set PYTHON to another interpreter): ${probe.error || probe.stderr}`);
  dir = mkdtempSync(join(tmpdir(), 'hmc-'));
  writeFileSync(join(dir, 'secret.txt'), SECRET);
  secretUrl = new URL(`file://${join(dir, 'secret.txt')}`).href;
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || '/', base);
    seen.push(`${req.method} ${url.pathname}${url.search}`);
    const route = Object.prototype.hasOwnProperty.call(routes(), url.pathname) ? routes()[url.pathname] : undefined;
    if (!route) { res.writeHead(404, { 'content-type': 'text/plain' }).end('missing'); return; }
    const out = route();
    res.writeHead(out.status || 200, { 'content-type': out.type || 'text/plain', ...out.headers }).end(out.body || '');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
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

  it('refuses a descriptor address that is not http(s)', async () => {
    const r = await hmc(['list', secretUrl]);
    expect(r.code).not.toBe(0);
    expect(r.stdout + r.stderr).not.toContain(SECRET);
    expect(r.stderr).toMatch(REFUSED);
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
