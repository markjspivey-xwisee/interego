// File transport only. It exposes one pending controller decision at a time.
import { readFile, writeFile, rename, access, realpath } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
const [directory, generationText, requestText] = process.argv.slice(2);
if (!directory || !generationText) throw new Error('usage: agent-client.mjs CASE_DIR GENERATION [REQUEST_NUMBER] < decision.json');
const dir = await realpath(resolve(directory)); const generation = Number(generationText);
const read = path => readFile(path, 'utf8').then(JSON.parse);
const pause = ms => new Promise(r => setTimeout(r, ms));
if (requestText !== undefined) {
  const pending = await read(join(dir, 'pending.json'));
  if (pending.done || pending.generation !== generation) throw new Error('controller generation is no longer active');
  const expected = join(dir, `decision-${String(Number(requestText)).padStart(2, '0')}.response.json`);
  if (pending.responsePath !== expected) throw new Error('decision is no longer pending');
  if (await access(expected).then(() => true, () => false)) throw new Error('decision already submitted');
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
  const content = Buffer.concat(chunks).toString('utf8'); JSON.parse(content);
  await writeFile(expected + '.tmp', content); await rename(expected + '.tmp', expected);
}
const started = Date.now();
while (Date.now() - started < 45000) {
  const pending = await read(join(dir, 'pending.json'));
  if (pending.done) { console.log(JSON.stringify({ status: 'DONE', success: pending.success })); process.exit(0); }
  if (pending.generation !== generation) { console.log(JSON.stringify({ status: 'HANDOFF', generation: pending.generation })); process.exit(0); }
  if (dirname(pending.requestPath) !== dir || dirname(pending.responsePath) !== dir) throw new Error('invalid pending request paths');
  if (!await access(pending.responsePath).then(() => true, () => false)) {
    const request = await read(pending.requestPath);
    console.log(JSON.stringify({ status: 'DECIDE', request: Number(pending.requestPath.match(/decision-(\d+)/)[1]), generation, prompt: request.prompt }));
    process.exit(0);
  }
  await pause(50);
}
console.log(JSON.stringify({ status: 'WAIT', message: 'No new decision yet; poll with the same directory and generation, without resubmitting.' }));
