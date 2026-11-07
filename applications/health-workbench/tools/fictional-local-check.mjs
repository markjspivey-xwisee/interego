import { constants, lstatSync, openSync, readSync, closeSync, fstatSync } from 'node:fs';
import { prepareFictionalLocalHealthCheck, verifyFictionalLocalHealthResponse } from '../fictional-local-check.mjs';

const USAGE = 'Use: node applications/health-workbench/tools/fictional-local-check.mjs prepare | check <response.json> --connection-id <id> [--note-id <id>]';
const MAX_RESPONSE_BYTES = 128 * 1024;
function readResponse(path) {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('Expected a regular response file.');
  // Nonblocking open also covers replacement by a FIFO after the precheck.
  const file = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    const after = fstatSync(file);
    if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino) throw new Error('Expected the same regular response file.');
    const bytes = Buffer.alloc(MAX_RESPONSE_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const read = readSync(file, bytes, size, bytes.length - size, null);
      if (!read) break;
      size += read;
    }
    if (size > MAX_RESPONSE_BYTES) throw new Error('Response exceeds the fictional check limit.');
    const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size));
    return JSON.parse(value.replace(/^\uFEFF/, ''));
  } finally { closeSync(file); }
}

try {
  const args = process.argv.slice(2);
  let result;
  if (args.length === 1 && args[0] === 'prepare') {
    result = prepareFictionalLocalHealthCheck();
  } else if ([4, 6].includes(args.length) && args[0] === 'check' && args[2] === '--connection-id'
    && (args.length === 4 || args[4] === '--note-id')) {
    result = verifyFictionalLocalHealthResponse(readResponse(args[1]), {
      expectedConnectionId: args[3], ...(args.length === 6 ? { expectedNoteId: args[5] } : {}),
    });
  } else { throw new Error(USAGE); }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch {
  // Never echo a supplied path, JSON parser excerpt, note, author label or secret.
  process.stderr.write(`Fictional local check failed. ${USAGE}\n`);
  process.exitCode = 1;
}
