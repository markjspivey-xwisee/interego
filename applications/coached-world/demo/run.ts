/**
 * Local world. Guests are provisional-play owners minted by the same
 * ProvisionalPlay class identity serves, in this process, until a service
 * key is configured and the relay signs the grants.
 *
 *   npx tsx applications/coached-world/demo/run.ts
 */
import { start } from '../src/server.js';

const port = Number(process.env['CPW_PORT'] ?? 6191);
const running = await start({ port, host: '127.0.0.1', bots: process.env['CPW_BOTS'] !== '0' });
process.stdout.write(`coached world ${running.url}\n`);
