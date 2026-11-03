/** Reproducible two-domain OFFLINE proof through separate CLI processes. */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture, learning, organizational } from './fixtures.mjs';

export async function runCli(args, call) {
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./stdio.mjs', import.meta.url)), ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  let result, stderr = '', forwarding = Promise.resolve();
  child.stderr.on('data', b => { stderr += b; });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    forwarding = forwarding.then(async () => {
      const message = JSON.parse(line);
      if (message.kind === 'result') { result = message; return; }
      if (message.kind !== 'call') throw new Error('Unexpected CLI protocol message');
      let reply;
      try { reply = { id: message.id, result: await call(message.tool, message.args) }; }
      catch (error) { reply = { id: message.id, transportError: String(error.message) }; }
      child.stdin.write(JSON.stringify(reply) + '\n');
    }).catch(error => { stderr += String(error.message); child.kill(); });
  });
  const exitCode = await new Promise((yes, no) => { child.on('error', no); child.on('close', yes); });
  await forwarding;
  if (exitCode !== 0 || !result) throw new Error('CLI proof failed: ' + stderr);
  return result;
}
export async function offlineProof(directory) {
  mkdirSync(directory, { recursive: true });
  const results = [];
  for (const [domain, task] of [['learning', learning], ['organizational', organizational]]) {
    const f = fixture(), configPath = join(directory, domain + '-config.json');
    writeFileSync(configPath, JSON.stringify({ task, catalogs: f.catalogs, seeds: f.seeds }), { mode: 0o600, flag: 'wx' });
    const prepared = await runCli(['prepare', configPath, join(directory, domain + '-prepare')], f.call);
    const executed = await runCli(['execute', configPath, join(directory, domain + '-execute'), prepared.reviewDigest], f.call);
    const result = JSON.parse(readFileSync(join(directory, domain + '-execute', 'result.json'), 'utf8'));
    if (result.status !== 'completed') throw new Error('Offline domain did not complete');
    results.push({ domain, status: executed.status, steps: result.run.metrics.automaticSteps, routineCalls: result.run.metrics.interegoCalls,
      preparationCalls: prepared.interegoCalls, executionCalls: executed.interegoCalls, modelInvocationsInsideExecutor: result.run.metrics.modelInvocations,
      providerInferenceCalls: null, monetaryCost: null, evidence: 'offline-fixture' });
  }
  const summary = { schema: 'interego.procedure-composition.offline-proof/v1', results,
    limit: 'Fixture signatures and domain outcomes. This proves functional composition and separate-process reuse, not live service execution or agent-performance superiority.' };
  writeFileSync(join(directory, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  return summary;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('Supply a new private output directory');
  offlineProof(resolve(process.argv[2])).then(result => process.stdout.write(JSON.stringify(result, null, 2) + '\n')).catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
}
