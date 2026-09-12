/** Post-measurement reconstruction only. This never calls a model or the network. */
import { createHash, createPublicKey } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { BenchmarkDescriptorStore, createEnvironment, verifyBenchmarkDescriptor, type Arm, type Scenario, type SignedBenchmarkDescriptor } from './environment.js';

const LABEL = 'POST-MEASUREMENT DETERMINISTIC RECONSTRUCTION';
const LIMITATION = 'These signed descriptor bytes were reconstructed after measurement by replaying recorded environment calls against the frozen seeded fixture. They are not originally retained signed bytes and are not additional model episodes. Matching transcripts establish reproducibility under this local benchmark transport, not a Railway or full-protocol attestation.';
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}';
  return JSON.stringify(value);
}
interface ToolEvent { event: string; tool: string; args: Record<string, unknown>; result: Record<string, unknown>; backendReads: number; elapsedMs: number }
interface MeasuredResult { arm: Arm; scenario: Scenario; seed: number; controller: string; inspection: Record<string, unknown> & { events: ToolEvent[] } }
interface Captured { id: string; publicKeyId: string; expectedSigner: string; descriptor: SignedBenchmarkDescriptor; episodes: string[] }
const withoutTiming = (event: Record<string, unknown>) => Object.fromEntries(Object.entries(event).filter(([key]) => key !== 'elapsedMs'));

export async function replayAudit(resultsDirectory: string, checkOnly = false) {
  const directory = resolve(resultsDirectory);
  const sourceDirectory = dirname(fileURLToPath(import.meta.url));
  const freeze = JSON.parse(await readFile(join(sourceDirectory, 'protocol-freeze.json'), 'utf8')) as { sha256: Record<string, string> };
  for (const [file, expected] of Object.entries(freeze.sha256)) {
    if (sha256(await readFile(join(sourceDirectory, file), 'utf8')) !== expected) throw new Error('frozen source hash mismatch: ' + file);
  }
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = join(directory, entry.name, 'result.json');
    try { await readFile(file); files.push(file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  if (!checkOnly && files.length !== 32) throw new Error(`final reconstruction requires all 32 measured episodes, found ${files.length}`);
  if (files.length === 0) throw new Error('no completed measured episodes found');
  const descriptors = new Map<string, Captured>();
  const publicKeys = new Map<string, string>();
  const episodes: Record<string, unknown>[] = [];
  let activeEpisode = '';
  let capturedPublications = 0;
  const originalPut = BenchmarkDescriptorStore.prototype.put;
  // Observe returned immutable envelopes without changing any input, return value,
  // key, state, transport counter or publication behavior. Always restore below.
  BenchmarkDescriptorStore.prototype.put = function (graph, content) {
    const descriptor = originalPut.call(this, graph, content);
    if (!verifyBenchmarkDescriptor(descriptor, this.publicKey, this.signer)) throw new Error('reconstructed publication failed signature verification');
    const publicKeyPem = this.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const publicKeyId = 'sha256:' + sha256(publicKeyPem);
    publicKeys.set(publicKeyId, publicKeyPem);
    const id = 'sha256:' + sha256(canonical({ publicKeyId, expectedSigner: this.signer, descriptor }));
    const existing = descriptors.get(id);
    if (existing) { if (!existing.episodes.includes(activeEpisode)) existing.episodes.push(activeEpisode); }
    else descriptors.set(id, { id, publicKeyId, expectedSigner: this.signer, descriptor: structuredClone(descriptor), episodes: [activeEpisode] });
    capturedPublications++;
    return descriptor;
  };
  try {
    for (const file of files) {
      activeEpisode = file.slice(directory.length + 1).replace(/\/result\.json$/, '');
      const originalBytes = await readFile(file, 'utf8');
      const measured = JSON.parse(originalBytes) as MeasuredResult;
      const startPublications = capturedPublications;
      const env = await createEnvironment({ arm: measured.arm, scenario: measured.scenario, seed: measured.seed });
      const toolEvents = measured.inspection.events.filter(event => event.event === 'tool');
      const mismatches: Record<string, unknown>[] = [];
      for (const [index, event] of toolEvents.entries()) {
        const actual = await env.call(event.tool, event.args);
        if (!isDeepStrictEqual(actual, event.result)) mismatches.push({ toolIndex: index, tool: event.tool, expected: event.result, reconstructed: actual });
      }
      const reconstructed = env.inspect();
      const expectedInspection = { ...measured.inspection, events: measured.inspection.events.map(event => withoutTiming(event as unknown as Record<string, unknown>)) };
      const actualInspection = { ...reconstructed, events: reconstructed.events.map(withoutTiming) };
      const inspectionMatches = isDeepStrictEqual(actualInspection, expectedInspection);
      episodes.push({ episode: activeEpisode, resultFileSha256: sha256(originalBytes), spec: { arm: measured.arm, controller: measured.controller, scenario: measured.scenario, seed: measured.seed },
        toolOutputsCompared: toolEvents.length, toolOutputsMatchExactly: mismatches.length === 0, inspectionMatchesExceptElapsedMs: inspectionMatches,
        reconstructedPublications: capturedPublications - startPublications, signaturesVerified: reconstructed.durableDescriptorsVerified, mismatches });
    }
  } finally { BenchmarkDescriptorStore.prototype.put = originalPut; }
  // Recheck exported values using only the captured public PEM and envelope.
  const exportedEnvelopesVerify = [...descriptors.values()].every(value => verifyBenchmarkDescriptor(value.descriptor, createPublicKey(publicKeys.get(value.publicKeyId)!), value.expectedSigner));
  const allMatch = exportedEnvelopesVerify && episodes.every(episode => episode['toolOutputsMatchExactly'] && episode['inspectionMatchesExceptElapsedMs'] && episode['signaturesVerified']);
  const generatedAt = new Date().toISOString();
  const descriptorArtifact = { label: LABEL, limitation: LIMITATION, generatedAt, schema: 'benchmark.reconstructed-signatures/v1', publicKeys: [...publicKeys].map(([id, publicKeyPem]) => ({ id, publicKeyPem })), descriptors: [...descriptors.values()] };
  const descriptorBytes = JSON.stringify(descriptorArtifact, null, 2) + '\n';
  const audit = { label: LABEL, limitation: LIMITATION, generatedAt, schema: 'benchmark.post-measurement-replay/v1', checkOnly, sourceFreeze: freeze,
    sourceSha256: sha256(await readFile(fileURLToPath(import.meta.url), 'utf8')), measuredEpisodes: episodes.length,
    toolOutputsCompared: episodes.reduce((count, episode) => count + Number(episode['toolOutputsCompared']), 0), capturedPublications, uniqueSignedDescriptors: descriptors.size,
    uniquePublicKeys: publicKeys.size, exportedEnvelopesVerify, allMatch, reconstructedDescriptorsFileSha256: sha256(descriptorBytes), episodes };
  if (!checkOnly) {
    await writeFile(join(directory, 'replayed-descriptors.json'), descriptorBytes);
    await writeFile(join(directory, 'replay-audit.json'), JSON.stringify(audit, null, 2) + '\n');
  }
  return audit;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = process.argv[2];
  if (!directory) throw new Error('usage: node --import tsx audit-replay.ts RESULTS_DIRECTORY [--check-only]');
  const audit = await replayAudit(directory, process.argv.includes('--check-only'));
  console.log(JSON.stringify({ label: LABEL, measuredEpisodes: audit.measuredEpisodes, toolOutputsCompared: audit.toolOutputsCompared, uniqueSignedDescriptors: audit.uniqueSignedDescriptors, exportedEnvelopesVerify: audit.exportedEnvelopesVerify, allMatch: audit.allMatch, checkOnly: audit.checkOnly }));
  if (!audit.allMatch) process.exitCode = 1;
}
