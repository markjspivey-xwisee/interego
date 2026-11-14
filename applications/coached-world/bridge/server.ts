/**
 * Process entry for the coached-world bridge. The handler is `src/server.ts`.
 * A rejection nothing awaited is logged here and the process keeps serving.
 */
import { installProcessSafetyNet } from '../../_shared/vertical-bridge/route-errors.js';
import { start } from '../src/server.js';

installProcessSafetyNet((msg) => { process.stderr.write(`[coached-world-bridge] ${msg}\n`); });

const port = Number(process.env['PORT'] ?? process.env['CPW_PORT'] ?? 6191);
start({ port, host: '0.0.0.0' }).then(running => {
  process.stdout.write(`coached world ${running.url}\n`);
}).catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
