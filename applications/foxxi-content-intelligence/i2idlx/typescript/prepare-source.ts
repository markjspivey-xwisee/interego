/** Native production source preparation: immutable canonical git history and SHA-256-pinned reasoner.
 * This does not publish state, alter the glossary, or bless new upstream versions.
 */
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { loadConfig } from './config.js';

export interface SourcePin { repository: string; commit: string; graphPath: string; graphSha256: string; release: string }
const hash = (raw: Uint8Array): string => createHash('sha256').update(raw).digest('hex');
function runGit(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 }).trim();
}
export async function prepareNativeSource(root: string, source: string): Promise<{ clone: string; commit: string; reasoner: string }> {
  root = resolve(root); source = resolve(source);
  const pin = JSON.parse(readFileSync(join(root, 'typescript', 'upstream-pin.json'), 'utf8')) as SourcePin;
  const cfg = loadConfig(root);
  if (pin.repository !== cfg.i2idl.repo || pin.release !== cfg.i2idl.release || pin.graphPath !== cfg.i2idl.graphPath ||
      !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(pin.repository) ||
      !/^[0-9a-f]{40}$/.test(pin.commit) || !/^[0-9a-f]{64}$/.test(pin.graphSha256) ||
      !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/.test(pin.graphPath)) throw new Error('Canonical source pin and build config disagree.');
  if (existsSync(join(source, '.git'))) {
    if (runGit(source, ['rev-parse', 'HEAD']) !== pin.commit || runGit(source, ['status', '--porcelain'])) throw new Error('Existing clone is dirty or is not the exact pinned commit; it will not be reset or overwritten.');
  } else {
    if (existsSync(source)) throw new Error('Clone destination already exists without a git repository; refusing to overwrite it.');
    mkdirSync(source, { recursive: true });
    runGit(source, ['init', '--quiet']);
    // No --depth: the release/history projections require the complete canonical history.
    runGit(source, ['fetch', '--quiet', pin.repository, pin.commit]);
    runGit(source, ['checkout', '--quiet', '--detach', 'FETCH_HEAD']);
  }
  if (runGit(source, ['rev-parse', 'HEAD']) !== pin.commit || runGit(source, ['rev-parse', '--is-shallow-repository']) !== 'false') throw new Error('Canonical clone is not complete at the pinned commit.');
  const raw = execFileSync('git', ['show', pin.commit + ':' + pin.graphPath], { cwd: source, maxBuffer: 128 * 1024 * 1024 });
  if (hash(raw) !== pin.graphSha256) throw new Error('Canonical glossary bytes failed SHA-256 verification.');
  const parsed: unknown = JSON.parse(raw.toString('utf8'));
  const graph = parsed && typeof parsed === 'object' ? (parsed as { '@graph'?: unknown })['@graph'] : null;
  const scheme = Array.isArray(graph) ? graph.find(x => x && typeof x === 'object' && x['@id'] === 'https://id.i2idl.org/scheme') : null;
  if (!scheme || scheme['gs:publicationVersion'] !== pin.release) throw new Error('Canonical glossary publicationVersion differs from the source pin.');
  const reasoner = cfg.reasoner.jar;
  if (!/^[0-9a-f]{64}$/.test(cfg.reasoner.sha256) || !cfg.reasoner.url.startsWith('https://github.com/ontodev/robot/releases/')) throw new Error('Reasoner pin is not a checked ROBOT release.');
  let jar: Buffer;
  if (existsSync(reasoner)) jar = readFileSync(reasoner);
  else {
    const r = await fetch(cfg.reasoner.url, { signal: AbortSignal.timeout(60000) });
    if (!r.ok) throw new Error('Pinned reasoner download failed: HTTP ' + r.status);
    jar = Buffer.from(await r.arrayBuffer());
  }
  if (hash(jar) !== cfg.reasoner.sha256) throw new Error('Reasoner bytes failed SHA-256 verification.');
  if (!existsSync(reasoner)) { mkdirSync(dirname(reasoner), { recursive: true }); writeFileSync(reasoner, jar); }
  return { clone: source, commit: pin.commit, reasoner };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [root, source] = process.argv.slice(2);
  if (!root || !source) throw new Error('Usage: tsx prepare-source.ts I2IDLX_ROOT NEW_CLONE_DIRECTORY');
  process.stdout.write(JSON.stringify(await prepareNativeSource(root, source)) + '\n');
}
