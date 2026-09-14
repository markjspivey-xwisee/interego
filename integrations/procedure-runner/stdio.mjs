/** JSON-lines bridge for an existing authenticated MCP host; not a new MCP tool. */
import { createInterface } from 'node:readline';
import { mkdirSync, openSync, writeSync, fsyncSync, closeSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runProcedure, unpackMcp } from './runner.mjs';
import { verifiedProcedureGraph } from './graph.mjs';
import { readRunRequest } from './request.mjs';
import { projectRepresentation } from './representations.mjs';

export async function executeLinkedRequest({ requestUrl, trustedSigner, call, onEvent, expectedStateCid }) {
  const started = Date.now();
  let bootstrapCalls = 0;
  const read = async (tool, args) => {
    const number = ++bootstrapCalls;
    await onEvent({ type: 'intent', phase: 'bootstrap', number, tool, args, atMs: Date.now() });
    const raw = await call(tool, args);
    await onEvent({ type: 'outcome', phase: 'bootstrap', number, raw, atMs: Date.now() });
    return raw;
  };
  const request = readRunRequest(await read('get_descriptor', { url: requestUrl }), { descriptorUrl: requestUrl, trustedSigner });
  const head = unpackMcp(await read('get_current_head', { pod_url: request.procedurePod, urn: request.procedureGraph }));
  if (head.forked !== false || head.head?.descriptorUrl !== request.procedureDescriptor || head.head?.cid !== request.procedureCid) throw new Error('Procedure pin is no longer the current unambiguous head');
  const compiled = verifiedProcedureGraph(await read('get_descriptor', { url: request.procedureDescriptor }), { descriptorUrl: request.procedureDescriptor, trustedSigner });
  await onEvent({ type: 'loaded-graph', phase: 'bootstrap', graph: compiled.graph, request, expectedStateCidOverride: expectedStateCid ?? null, atMs: Date.now() });
  const bootstrapElapsedMs = Date.now() - started;
  const input = { ...request.input, ...(expectedStateCid ? { expectedStateCid } : {}) };
  const result = await runProcedure(compiled.procedure, input, {
    call, onEvent: event => onEvent({ ...event, phase: 'procedure' }), project: projectRepresentation, maxCalls: 16
  });
  return { ...result, source: { requestUrl, procedureDescriptor: request.procedureDescriptor, procedureCid: request.procedureCid,
    representation: compiled.graph.representation, executionSource: compiled.graph.executionSource },
    bootstrap: { interegoCalls: bootstrapCalls, elapsedMs: bootstrapElapsedMs }, totalElapsedMs: Date.now() - started };
}

async function main() {
  const [requestUrl, trustedSigner, outputDirectory, expectedStateCid] = process.argv.slice(2);
  if (!requestUrl || !trustedSigner || !outputDirectory) throw new Error('Usage: node stdio.mjs REQUEST_DESCRIPTOR TRUSTED_SIGNER OUTPUT_DIRECTORY [EXPECTED_STATE_CID]');
  mkdirSync(outputDirectory, { recursive: true });
  const fd = openSync(join(outputDirectory, 'events.jsonl'), 'ax', 0o600);
  let previousHash = null;
  const onEvent = async event => {
    const payload = JSON.stringify({ previousHash, event });
    const sha256 = createHash('sha256').update(payload).digest('hex');
    writeSync(fd, JSON.stringify({ previousHash, event, sha256 }) + '\n');
    fsyncSync(fd);
    previousHash = sha256;
  };
  // An interactive host can keep stdin open without echoing private MCP results.
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  const lines = createInterface({ input: process.stdin });
  let sequence = 0, pending;
  lines.on('line', line => {
    try {
      const response = JSON.parse(line);
      if (!pending || response.id !== pending.id) throw new Error('Unexpected host response');
      const request = pending; pending = null;
      if (response.transportError) request.reject(new Error(response.transportError));
      else request.resolve(response.result);
    } catch (error) { pending?.reject(error); pending = null; }
  });
  const call = (tool, args) => new Promise((resolveCall, reject) => {
    if (pending || !['get_descriptor', 'get_current_head', 'dereference', 'act'].includes(tool)) return reject(new Error('Unsupported or concurrent transport request'));
    const id = ++sequence;
    pending = { id, resolve: resolveCall, reject };
    process.stdout.write(JSON.stringify({ kind: 'call', id, tool, args }) + '\n');
  });
  try {
    const result = await executeLinkedRequest({ requestUrl, trustedSigner, expectedStateCid, call, onEvent });
    await onEvent({ type: 'run-result', result, atMs: Date.now() });
    writeFileSync(join(outputDirectory, 'result.json'), JSON.stringify({ ...result, journalTail: previousHash }, null, 2) + '\n', { mode: 0o600 });
    process.stdout.write(JSON.stringify({ kind: 'result', status: result.status, step: result.step, reason: result.reason,
      metrics: result.metrics, bootstrap: result.bootstrap, totalElapsedMs: result.totalElapsedMs, output: result.output, observation: result.observation }) + '\n');
  } finally {
    closeSync(fd); lines.close();
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(String(error.stack ?? error) + '\n'); process.exitCode = 1; });
}
