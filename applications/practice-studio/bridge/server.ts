/**
 * Process entry. Listens on PORT (default 6120) and HOST (default 127.0.0.1).
 * Records stay in this process. BRIDGE_DEPLOYMENT_URL is the origin written into
 * affordance targets when the process sits behind a proxy.
 */
import { createStudioApp } from '../src/server.js';

const port = Number(process.env['PORT'] ?? 6120);
const host = process.env['HOST'] ?? '127.0.0.1';
const deploymentUrl = (process.env['BRIDGE_DEPLOYMENT_URL'] ?? '').trim() || undefined;
const app = createStudioApp(undefined, deploymentUrl);

app.listen(port, host, () => {
  process.stdout.write(`practice studio http://${host}:${port}/ui\n`);
});
