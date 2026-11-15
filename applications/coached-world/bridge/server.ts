/**
 * Process entry for the coached-world bridge. The handler is `src/server.ts`.
 * A rejection nothing awaited is logged here and the process keeps serving.
 *
 * Deployed, the process listens on a private port behind a proxy, so the address people reach
 * it at is a setting: `BRIDGE_DEPLOYMENT_URL` (the name the other bridges use) or
 * `CPW_PUBLIC_URL`. An empty value is unset, which is what an image's blank `ENV` line leaves.
 * A value that is not an https origin stops the process at start, saying why.
 */
import { installProcessSafetyNet } from '../../_shared/vertical-bridge/route-errors.js';
import { start } from '../src/server.js';

installProcessSafetyNet((msg) => { process.stderr.write(`[coached-world-bridge] ${msg}\n`); });

const port = Number(process.env['PORT'] ?? process.env['CPW_PORT'] ?? 6191);
const publicUrl = (process.env['BRIDGE_DEPLOYMENT_URL'] ?? '').trim() || (process.env['CPW_PUBLIC_URL'] ?? '').trim() || undefined;
start({ port, host: '0.0.0.0', bots: process.env['CPW_BOTS'] !== '0', ...(publicUrl ? { publicUrl } : {}) }).then(running => {
  process.stdout.write(`coached world ${running.origin} (listening on ${running.url})\n`);
  if (!publicUrl) {
    process.stderr.write('[coached-world-bridge] no public URL is set, so the world names itself by its listen address. '
      + 'Behind a proxy set BRIDGE_DEPLOYMENT_URL to the https origin people use.\n');
  }
}).catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
