/**
 * Independent, end-to-end migration gate.
 * Python is an oracle here only; no native production module invokes it.
 * Recompute both complete builds over identical source/evidence inputs, compare
 * all ten publishable RDF graphs plus decorations, and compare fresh reports.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, appendFileSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_ROOT, loadConfig, type BuildConfig } from './config.js';
import { buildNative } from './build.js';
import { checkAppData } from './check-app-data.js';
import { canonicalRdf, compareRdfFiles } from './parity.js';
import { refreshEvidence } from './refresh-evidence.js';
import { refreshUpper } from './refresh-upper.js';
import { verifyPublished } from './verify-published.js';
import { progress, progressStage } from './progress.js';

export const UPSTREAM_COMMIT = '9f865995d879165d8fa49422915a5e53d2ecebf9';
const FIXED_NOW = '2026-10-13T20:30:00+00:00';
const FIXED_BUILT = '2026-10-08';
const FIXED_MODIFIED = '2026-10-13';
const GRAPH_KEYS = ['shapes', 'ontology', 'rules', 'catalog', 'enactments', 'mappings', 'releases', 'changes', 'alignments', 'referents'] as const;
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
interface GoldenOptions { prepareInputs?: boolean; compareOnly?: boolean; python?: string; outputDir?: string }
interface RdfResult { graph: string; file: string; isomorphic: boolean; expectedHash: string; actualHash: string }

async function command(executable: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv, logFile: string): Promise<string> {
  await mkdir(dirname(logFile), { recursive: true });
  await writeFile(logFile, '');
  const stage = 'command:' + logFile.slice(logFile.lastIndexOf('/') + 1), started = Date.now();
  progress(stage, 'start', { executable, args });
  let output = '';
  const heartbeat = setInterval(() => progress(stage, 'heartbeat', { seconds: (Date.now() - started) / 1000 }), 30000);
  heartbeat.unref();
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(executable, [...args], { cwd, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    progress(stage, 'spawn', { childPid: child.pid });
    const chunk = (data: Buffer): void => {
      appendFileSync(logFile, data); output += data.toString('utf8'); process.stdout.write(data);
    };
    child.stdout.on('data', chunk);
    child.stderr.on('data', chunk);
    child.once('error', error => { progress(stage, 'error', { error: String(error) }); reject(error); });
    child.once('close', code => {
      progress(stage, 'exit', { code, seconds: (Date.now() - started) / 1000 });
      if (code === 0) resolvePromise();
      else reject(new Error(executable + ' ' + args.join(' ') + ' failed with exit code ' + code));
    });
  }).finally(() => { clearInterval(heartbeat); });
  return output;
}
function normalizeTiming(value: Json, path = ''): Json {
  if (path === 'owlrl.seconds' || path === 'disjointCheck.seconds' || /^hermit\.[^.]+\.(?:sample|clash)\.seconds$/u.test(path)) {
    assert.equal(typeof value, 'number', 'only a measured numeric duration can be omitted at ' + path);
    return '<measured duration>';
  }
  if (Array.isArray(value)) return value.map((v, i) => normalizeTiming(v, path + '[' + i + ']'));
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k =>
    [k, normalizeTiming(value[k]!, path ? path + '.' + k : k)]));
  return value;
}
function difference(expected: Json, actual: Json, path = '$'): string | null {
  if (Object.is(expected, actual)) return null;
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) return path + ': array length ' + expected.length + ' / ' + actual.length;
    for (let i = 0; i < expected.length; i++) {
      const result = difference(expected[i]!, actual[i]!, path + '[' + i + ']');
      if (result) return result;
    }
    return null;
  }
  if (expected !== null && actual !== null && typeof expected === 'object' && typeof actual === 'object' &&
      !Array.isArray(expected) && !Array.isArray(actual)) {
    const a = Object.keys(expected).sort(), b = Object.keys(actual).sort();
    if (JSON.stringify(a) !== JSON.stringify(b)) return path + ': object keys differ (' + a.join(', ') + ' / ' + b.join(', ') + ')';
    for (const key of a) { const result = difference(expected[key]!, actual[key]!, path + '.' + key); if (result) return result; }
    return null;
  }
  return path + ': ' + JSON.stringify(expected) + ' / ' + JSON.stringify(actual);
}
async function json(file: string): Promise<Json> { return JSON.parse(await readFile(file, 'utf8')) as Json; }
async function sourceInputs(root: string): Promise<Record<string, string>> {
  const paths: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === '__pycache__') continue;
      const file = join(dir, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) paths.push(file);
    }
  }
  await walk(join(root, 'evidence'));
  paths.push(join(root, 'config.json'), join(root, 'publications.json'));
  return Object.fromEntries(await Promise.all(paths.sort().map(async file =>
    [file.slice(root.length + 1), createHash('sha256').update(await readFile(file)).digest('hex')])));
}
async function prepareInputs(root: string): Promise<void> {
  // Immutable upper publisher bytes are restored only when their pins still match.
  await progressStage('inputs:upper', () => refreshUpper(root));
  const cfg = loadConfig(root), snapshots = join(root, '.cache', 'golden-inputs');
  // The original xAPI endpoints expose no versioned URL in config. Fetch their
  // absent snapshots once, record hashes, and share those exact bytes across both
  // engines. Keep the committed Foxxi/relay/app snapshots and their old seeds.
  const missing = ['xapi-ontology.ttl', 'xapi-profile-ontology.ttl'].filter(file => !existsSync(join(root, 'evidence', file)));
  if (missing.length) {
    await progressStage('inputs:xapi-base', () => refreshEvidence(root, { mode: 'base', outputDir: snapshots }));
    for (const file of missing) await copyFile(join(snapshots, file), join(root, 'evidence', file));
  }
  const reasoner = cfg.reasoner.jar;
  if (!existsSync(reasoner)) await progressStage('inputs:reasoner', () => refreshEvidence(root, { mode: 'reasoner', reasonerFile: reasoner }));
  assert.equal(createHash('sha256').update(await readFile(reasoner)).digest('hex'), cfg.reasoner.sha256, 'ROBOT jar differs from its recorded pin');
}
function fixedEnvironment(cfg: BuildConfig): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env,
    TZ: 'UTC', PYTHONHASHSEED: '0', I2IDLX_BUILT_DATE: FIXED_BUILT, I2IDLX_MODIFIED: FIXED_MODIFIED,
    I2IDLX_NOW: FIXED_NOW, I2IDLX_HERMIT: '1', I2IDL_CLONE: cfg.i2idl.localClone,
    INTEREGO_CORE_SRC: cfg.interegoCoreSrc, INTEREGO_TSX: cfg.tsx, I2IDLX_REASONER_JAR: cfg.reasoner.jar,
  };
  // Do not let unrelated per-graph stamps or a developer skip enter this gate.
  for (const key of Object.keys(env)) if (key.startsWith('I2IDLX_NOW_')) delete env[key];
  delete env.I2IDLX_ALLOW_UNPUBLISHED;
  return env;
}
export async function checkParity(root = DEFAULT_ROOT, options: GoldenOptions = {}): Promise<void> {
  root = resolve(root);
  const cfg = loadConfig(root), output = resolve(options.outputDir || join(root, '.cache', 'golden-parity'));
  await mkdir(output, { recursive: true });
  const python = options.python || process.env.PYTHON || 'python3';
  const env = fixedEnvironment(cfg), originalEnv = { ...process.env };
  const baseline = join(root, 'dist'), native = join(root, 'dist-ts');
  const oracleApp = join(root, 'app', 'build'), nativeApp = join(root, 'app', 'build-ts');
  const oracleSite = join(root, 'site'), nativeSite = join(root, 'site-ts');
  // Native code reads process.env, while the independent Python oracle receives
  // the same immutable environment through spawn.
  Object.assign(process.env, env);
  process.env.I2IDLX_PROGRESS_FILE = join(output, 'stage-progress.jsonl');
  progress('golden', 'start', { root, fixedNow: FIXED_NOW });
  for (const key of Object.keys(process.env)) if (key.startsWith('I2IDLX_NOW_')) delete process.env[key];
  delete process.env.I2IDLX_ALLOW_UNPUBLISHED;
  const rdf: RdfResult[] = [], failures: string[] = [];
  const report: Record<string, unknown> = { status: 'running', fixedNow: FIXED_NOW, builtDate: FIXED_BUILT, modifiedDate: FIXED_MODIFIED, upstreamCommit: UPSTREAM_COMMIT, ignored: ['owlrl.seconds', 'disjointCheck.seconds', 'hermit.*.sample/clash.seconds', 'app meta.built'], rdf };
  try {
    const head = (await command('git', ['rev-parse', 'HEAD'], cfg.i2idl.localClone, env, join(output, 'upstream-head.log'))).trim();
    assert.equal(head, UPSTREAM_COMMIT, 'upstream HEAD is not the full pinned commit');
    const shallow = (await command('git', ['rev-parse', '--is-shallow-repository'], cfg.i2idl.localClone, env, join(output, 'upstream-history.log'))).trim();
    assert.equal(shallow, 'false', 'full upstream history is required to derive releases and fact-level changes');
    if (options.prepareInputs) await progressStage('inputs:all', () => prepareInputs(root));
    const before = await sourceInputs(root);
    await writeFile(join(output, 'input-fingerprints.json'), JSON.stringify(before, null, 2) + '\n');
    if (!options.compareOnly) {
      await command(python, ['-u', '-I', join(root, 'build.py')], root, env, join(output, 'python-build.log'));
      await command(python, ['-I', join(root, 'tools', 'publication_record.py'), root], root, env, join(output, 'python-publications.log'));
      // Rendering needs a walkthrough file; execute the independent existing
      // read-only oracle walk rather than copying a native report into it.
      await command(python, ['-I', join(root, 'tools', 'agent_walk.py'), root], root, env, join(output, 'python-walk.log'));
      await command(python, ['-I', join(root, 'tools', 'build_app.py'), root], root, env, join(output, 'python-app.log'));
      await command(python, ['-I', join(root, 'tools', 'build_site.py'), root], root, env, join(output, 'python-site.log'));
      await progressStage('native:complete-build', () => buildNative(root, { outputDir: native, appDir: nativeApp, siteDir: nativeSite, skipHermit: false }));
    }
    assert.deepEqual(await sourceInputs(root), before, 'builds altered their shared input evidence');
    for (const key of [...GRAPH_KEYS, 'decorations']) {
      const slug = cfg.slugs[key];
      if (!slug) throw new Error('No graph slug for ' + key);
      const file = slug + '.ttl', comparison = await progressStage('compare:rdf:' + key, () => compareRdfFiles(join(baseline, file), join(native, file), cfg.relayNsRoot + '/' + cfg.owner + '/' + slug));
      rdf.push({ graph: key, file, ...comparison });
      process.stdout.write((comparison.isomorphic ? 'PASS ' : 'FAIL ') + key + ' RDF isomorphism ' + comparison.expectedHash + ' / ' + comparison.actualHash + '\n');
      if (!comparison.isomorphic) {
        failures.push(key + ' graph is not RDF-isomorphic');
        const baseIri = cfg.relayNsRoot + '/' + cfg.owner + '/' + slug;
        await writeFile(join(output, key + '.python.canonical.nq'), await canonicalRdf(await readFile(join(baseline, file), 'utf8'), 'turtle', baseIri));
        await writeFile(join(output, key + '.native.canonical.nq'), await canonicalRdf(await readFile(join(native, file), 'utf8'), 'turtle', baseIri));
      }
    }
    const expectedSemantic = normalizeTiming(await json(join(baseline, 'semantic-layer.json')));
    const actualSemantic = normalizeTiming(await json(join(native, 'semantic-layer.json')));
    const semanticDiff = difference(expectedSemantic, actualSemantic);
    report.semantic = { equal: semanticDiff === null, difference: semanticDiff };
    if (semanticDiff) failures.push('fresh semantic report differs: ' + semanticDiff);
    const publicationDiff = difference(await json(join(baseline, 'published.json')), await json(join(native, 'published.json')));
    report.publications = { equal: publicationDiff === null, difference: publicationDiff };
    if (publicationDiff) failures.push('independently read signed publication receipts differ: ' + publicationDiff);
    try { report.app = checkAppData(join(nativeApp, 'data.json'), join(oracleApp, 'data.json')); }
    catch (error) { failures.push(String(error)); report.app = { equal: false, error: String(error) }; }
    for (const file of [join(oracleSite, 'index.html'), join(oracleSite, 'app.html'), join(nativeSite, 'index.html'), join(nativeSite, 'app.html')]) {
      assert.ok((await readFile(file)).length > 0, 'a requested site artifact was not generated: ' + file);
    }
    const verification = await json(join(native, 'native-verification.json'));
    if (verification === null || typeof verification !== 'object' || Array.isArray(verification)) throw new Error('Invalid native verification receipt');
    assert.equal(verification.partial, false, 'native HermiT validation was skipped');
    assert.deepEqual(verification.failures, [], 'native full verification reported failed gates');
    const semantic = await json(join(native, 'semantic-layer.json'));
    assert.ok(semantic !== null && typeof semantic === 'object' && !Array.isArray(semantic) && semantic.hermit && Object.keys(semantic.hermit).length > 0, 'HermiT returned no fresh results');
    const published = await progressStage('compare:live-representations', () => verifyPublished(root, { outputDir: native }));
    report.liveRepresentations = published;
    if (published.graphs.length !== GRAPH_KEYS.length) failures.push('live publication verification checked ' + published.graphs.length + ', expected all ten graphs');
    if (!published.ok) failures.push('native outputs differ from live negotiated publications: ' + published.failed.join(', '));
    report.status = failures.length ? 'failed' : 'passed';
    report.failures = failures;
    if (failures.length) throw new Error('Golden parity failed:\n' + failures.join('\n'));
    process.stdout.write('PASS all ten publishable graphs, local decorations, fresh semantics, verified publication receipts and workbench data match the independent complete Python build; all ten live Turtle/JSON-LD graphs match and HyperMarkdown resolves.\n');
  } catch (error) {
    progress('golden', 'error', { error: String(error) });
    report.status = 'failed'; report.error = String(error);
    throw error;
  } finally {
    progress('golden', 'end', { status: report.status });
    await writeFile(join(output, 'parity-report.json'), JSON.stringify(report, null, 2) + '\n');
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), root = args[0]?.startsWith('--') ? undefined : args[0];
  await checkParity(root, { prepareInputs: args.includes('--prepare-inputs'), compareOnly: args.includes('--compare-only') });
}
