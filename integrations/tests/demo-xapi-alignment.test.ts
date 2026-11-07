import { describe, it, expect } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { Parser, Store, DataFactory } from 'n3';
import { demoExperienceRdf } from '../../examples/xapi-record-rdf.js';

const { namedNode: nn } = DataFactory;
const XAPI = 'https://foxxi-bridge.interego.xwisee.com/ns/xapi#';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
function execute(code: string, values: Record<string, unknown>) {
  return runInNewContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, values);
}
function verify(graph: string, count: number) {
  const store = new Store(new Parser().parse(graph));
  const records = store.getSubjects(nn(RDF + 'type'), nn(XAPI + 'Statement'), null);
  expect(records).toHaveLength(count);
  expect([...store].some(q => q.predicate.value.includes('ontology#result/'))).toBe(false);
  expect(store.countQuads(null, nn(RDF + 'type'), nn('https://w3id.org/xapi/ontology#Statement'), null)).toBe(0);
  for (const record of records) {
    const original = store.getObjects(record, nn('https://schema.org/about'), null)[0]!;
    expect(original.value).not.toBe(record.value);
    expect(store.countQuads(original, nn(RDF + 'type'), nn(XAPI + 'Statement'), null)).toBe(0);
    const result = store.getObjects(record, nn(XAPI + 'result'), null)[0]!;
    const score = store.getObjects(result, nn(XAPI + 'score'), null)[0]!;
    expect(score.termType).toBe('BlankNode');
    expect(store.countQuads(score, nn(XAPI + 'raw'), null, null)).toBe(1);
    expect(store.countQuads(result, nn(XAPI + 'duration'), null, null)).toBe(1);
    const source = store.getObjects(record, nn('http://www.w3.org/ns/prov#wasDerivedFrom'), null)[0]!;
    expect(source.value).not.toBe(original.value);
    const payload = JSON.parse(store.getObjects(source, nn(RDF + 'value'), null)[0]!.value);
    expect(payload.legacyIri).toBe(original.value);
    expect(payload.experience.score).toBe(Number(store.getObjects(score, nn(XAPI + 'raw'), null)[0]!.value));
  }
  return store;
}
describe('actual legacy demo producers', () => {
  it('boots the actual standalone browser build without a source-tree helper at runtime', async () => {
    const temporary = mkdtempSync(join(tmpdir(), 'interego-pgsl-browser-runtime-'));
    try {
      const browser = join(temporary, 'examples/pgsl-browser');
      mkdirSync(browser, { recursive: true });
      for (const name of ['server.ts', 'package.json', 'index.html', 'observatory.html']) {
        cpSync(join(ROOT, 'examples/pgsl-browser', name), join(browser, name));
      }
      cpSync(join(ROOT, 'examples/xapi-record-rdf.ts'), join(temporary, 'examples/xapi-record-rdf.ts'));
      const link = (source: string, target: string) => symlinkSync(realpathSync(source), target, process.platform === 'win32' ? 'junction' : 'dir');
      mkdirSync(join(browser, 'node_modules/@interego'), { recursive: true });
      for (const name of ['core', 'pgsl', 'solid', 'security-txt']) {
        link(join(ROOT, 'node_modules/@interego', name), join(browser, 'node_modules/@interego', name));
      }
      // The root uses Express 5; this standalone package and relay both lock Express 4.
      const expressManifest = require.resolve('express/package.json', { paths: [join(ROOT, 'deploy/mcp-relay')] });
      const browserLock = JSON.parse(readFileSync(join(ROOT, 'examples/pgsl-browser/package-lock.json'), 'utf8')) as { packages: Record<string, { version?: string }> };
      expect(JSON.parse(readFileSync(expressManifest, 'utf8')).version).toBe(browserLock.packages['node_modules/express']!.version);
      link(dirname(expressManifest), join(browser, 'node_modules/express'));
      const script = (JSON.parse(readFileSync(join(browser, 'package.json'), 'utf8')) as { scripts: { build: string } }).scripts.build.split(/\s+/);
      expect(script.shift()).toBe('esbuild');
      // POSIX installs replace this launcher with a native binary; Windows keeps JavaScript.
      const esbuildCli = join(ROOT, 'node_modules/esbuild/bin/esbuild');
      const buildCommand = process.platform === 'win32' ? process.execPath : esbuildCli;
      const buildArguments = process.platform === 'win32' ? [esbuildCli, ...script] : script;
      execFileSync(buildCommand, buildArguments, { cwd: browser });
      // The image ships dist and external npm packages, never the original TypeScript.
      rmSync(join(browser, 'server.ts'));
      rmSync(join(temporary, 'examples/xapi-record-rdf.ts'));
      const networkLog = join(temporary, 'network-attempts.txt');
      const guard = join(temporary, 'deny-network.mjs');
      writeFileSync(guard, `import http from 'node:http'; import https from 'node:https'; import { appendFileSync } from 'node:fs';\nconst deny = () => { appendFileSync(${JSON.stringify(networkLog)}, 'attempt\\n'); throw Error('UNEXPECTED_BROWSER_NETWORK'); };\nglobalThis.fetch = deny; http.request = deny; http.get = deny; https.request = deny; https.get = deny;\n`);
      const reservation = createServer();
      await new Promise<void>(ready => reservation.listen(0, '127.0.0.1', ready));
      const address = reservation.address();
      if (!address || typeof address === 'string') throw Error('Expected a local port');
      await new Promise<void>((done, reject) => reservation.close(error => error ? reject(error) : done()));
      const child = spawn(process.execPath, ['--import', pathToFileURL(guard).href, join(browser, 'dist/server.js')], {
        cwd: browser,
        env: { ...process.env, CLEAN: '1', PORT: String(address.port), INTEREGO_BUILD_SHA: 'standalone-runtime-fixture' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', chunk => { output += String(chunk); });
      child.stderr.on('data', chunk => { output += String(chunk); });
      try {
        let health: { status?: string; build?: string } | undefined;
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline && !health) {
          if (child.exitCode !== null) throw Error(`The emitted browser exited ${child.exitCode}: ${output}`);
          try {
            const response = await fetch(`http://127.0.0.1:${address.port}/health`, { signal: AbortSignal.timeout(500) });
            if (response.status === 200) health = await response.json() as typeof health;
          } catch { /* The real server may still be loading its external packages. */ }
          if (!health) await delay(100);
        }
        expect(health, output).toEqual({ status: 'ok', build: 'standalone-runtime-fixture' });
        expect(existsSync(networkLog), 'CLEAN startup must not contact any pod or production service').toBe(false);
      } finally {
        child.kill();
        if (child.exitCode === null) await new Promise<void>(done => child.once('exit', () => done()));
      }
    } finally {
      if (dirname(resolve(temporary)) !== resolve(tmpdir())) throw Error('Unexpected temporary directory');
      rmSync(temporary, { recursive: true, force: true });
    }
  }, 30_000);

  it('runs the actual browser producer function with its original fixture shape', () => {
    const source = readFileSync(new URL('../../examples/pgsl-browser/server.ts', import.meta.url), 'utf8');
    const body = source.slice(source.indexOf('function xapiToRdf('), source.indexOf('\ninterface DemoState'));
    const fixture = { verb: 'completed', activity: 'test-activity', activityName: 'Synthetic test', score: 92, success: true, duration: 'PT45M', timestamp: '2026-03-15T14:30:00Z' };
    const values = { demoExperienceRdf, LEARNER_INFO: { fixture: { did: 'urn:fixture:actor' } }, fixture };
    const graph = execute(body + '\nxapiToRdf("fixture", [fixture]);', values) as string;
    verify(graph, 1);
    expect(execute(body + '\nxapiToRdf("fixture", [fixture]);', values)).toBe(graph);
  });
  it('runs the actual TLA producer expression and preserves the legacy registration as source data', () => {
    const source = readFileSync(new URL('../../examples/multi-agent/tla-demo.ts', import.meta.url), 'utf8');
    const start = source.indexOf('  const experiences = '), end = source.indexOf("\n  log('LRS', '5 xAPI statements received:", start);
    expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
    const graph = execute(source.slice(start, end) + '\nxapiGraph;', { demoExperienceRdf }) as string;
    const store = verify(graph, 5);
    expect(store.countQuads(null, nn(XAPI + 'registration'), null, null)).toBe(0);
    expect(store.getObjects(null, nn(RDF + 'value'), null).some(value => JSON.parse(value.value).experience.context.registration === 'urn:reg:chen-ils-2026-03')).toBe(true);
  });
  it('refuses malformed values and IRIs rather than serializing injected triples', () => {
    const fixture = { verb: 'completed', activity: 'test', activityName: 'Synthetic', score: NaN, success: true, duration: 'PT1M', timestamp: '2026-03-15T14:30:00Z' };
    expect(() => demoExperienceRdf('urn:test', 'urn:actor', fixture)).toThrow();
    expect(() => demoExperienceRdf('urn:test> . <urn:inject', 'urn:actor', { ...fixture, score: 1 })).toThrow();
    for (const unsafe of ['|', '^', '`', '\\', '\u0000']) {
      expect(() => demoExperienceRdf('urn:test', 'urn:actor' + unsafe, { ...fixture, score: 1 })).toThrow();
    }
  });
});
