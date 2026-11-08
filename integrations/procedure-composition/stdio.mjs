/** JSON-lines adapter for the same authenticated host used by procedure-runner. */
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { mkdirSync, openSync, writeSync, fsyncSync, closeSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareComposition, executeComposition } from './composition.mjs';

export function createJournal(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const fd = openSync(join(directory, 'events.jsonl'), 'ax', 0o600);
  let tail = null, closed = false;
  return {
    get tail() { return tail; },
    onEvent: async event => {
      if (closed) throw new Error('Journal is closed');
      const payload = JSON.stringify({ previousHash: tail, event });
      const sha256 = createHash('sha256').update(payload).digest('hex');
      writeSync(fd, JSON.stringify({ previousHash: tail, event, sha256 }) + '\n'); fsyncSync(fd); tail = sha256;
    },
    close: () => { if (!closed) { closed = true; closeSync(fd); } }
  };
}

async function main() {
  const [mode, configPath, outputPath, reviewDigest] = process.argv.slice(2);
  if (!['prepare', 'execute'].includes(mode) || !configPath || !outputPath || (mode === 'execute' && !reviewDigest)) {
    throw new Error('Usage: node --import tsx stdio.mjs prepare|execute CONFIG_JSON NEW_PRIVATE_DIRECTORY [REVIEW_DIGEST]');
  }
  if (!statSync(configPath).isFile() || statSync(configPath).size > 64 * 1024) throw new Error('Expected a bounded configuration file');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  // Reject unknown keys rather than allowing configuration to override host functions.
  if (!config || typeof config !== 'object' || Array.isArray(config)
      || Object.keys(config).some(k => !['task', 'catalogs', 'seeds', 'selectedProductId'].includes(k))) throw new Error('Invalid composition configuration');
  const directory = resolve(outputPath), journal = createJournal(directory);
  const save = (name, content) => writeFileSync(join(directory, name), content, { mode: 0o600, flag: 'wx' });
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  const lines = createInterface({ input: process.stdin });
  let pending, sequence = 0, ended = false;
  const stop = error => { ended = true; if (pending) { pending.reject(error); pending = undefined; } };
  lines.on('close', () => stop(new Error('Authenticated host closed its response stream')));
  process.stdin.on('error', stop);
  lines.on('line', line => {
    try {
      const response = JSON.parse(line);
      if (!pending || response.id !== pending.id) throw new Error('Unexpected host response');
      const request = pending; pending = undefined;
      if (response.transportError) request.reject(new Error(response.transportError));
      else request.resolve(response.result);
    } catch (error) { stop(error); }
  });
  const call = (tool, args) => new Promise((resolveCall, reject) => {
    if (pending || ended || !['get_descriptor', 'get_current_head', 'dereference', 'act'].includes(tool)) return reject(new Error('Unsupported or unavailable host transport'));
    const id = ++sequence; pending = { id, resolve: resolveCall, reject };
    process.stdout.write(JSON.stringify({ kind: 'call', id, tool, args }) + '\n');
  });
  try {
    const options = { ...config, call, onEvent: journal.onEvent };
    const result = mode === 'prepare' ? await prepareComposition(options) : await executeComposition({ ...options, reviewDigest });
    await journal.onEvent({ type: 'cli-result', status: result.status, reviewDigest: result.reviewDigest ?? null });
    save('result.json', JSON.stringify({ ...result, journalTail: journal.tail }, null, 2) + '\n');
    if (result.hmd) save('review.hmd.md', result.hmd);
    if (result.procedureHmd) save('procedure.hmd.md', result.procedureHmd);
    process.stdout.write(JSON.stringify({ kind: 'result', status: result.status, reviewDigest: result.reviewDigest, interegoCalls: sequence }) + '\n');
  } catch (error) {
    await journal.onEvent({ type: 'cli-error', reason: String(error.message) });
    throw error;
  } finally {
    journal.close(); lines.close();
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => {
  process.stderr.write(String(error.message) + '\n'); process.exitCode = 1;
});
