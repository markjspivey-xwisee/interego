/**
 * Process entry for the coached-world bridge. The handler is `src/server.ts`.
 */
import { start } from '../src/server.js';

const port = Number(process.env['PORT'] ?? process.env['CPW_PORT'] ?? 6191);
start({ port, host: '0.0.0.0' }).then(running => {
  process.stdout.write(`coached world ${running.url}\n`);
}).catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
