/**
 * mcp-server starts its own Solid server when its home pod is on localhost and nothing answers.
 *
 * spec/STORAGE-TIERS.md, Tier 1, says the MCP auto-spawns CSS. It ran the root's
 * node_modules/.bin/community-solid-server with examples/multi-agent/css-config.json, and that never
 * booted: Components.js walked up from the root's CSS into the root's node_modules, found the root's
 * @comunica 5 beside CSS's own @comunica 2, and refused the config ("Could not build the config
 * files … ActorDereference … is not a valid component"). The tool call that needed the pod then
 * waited out the 30 s startup timeout and failed.
 *
 * So this starts mcp-server as an MCP client does, over stdio from source, with a home pod on a free
 * localhost port that nothing answers, calls a tool that needs the pod, and holds the server to what
 * Tier 1 promises: the Solid server boots, answers HTTP, holds the home pod, keeps its files where
 * CG_CSS_ROOT_FILE_PATH says, and stops when mcp-server does.
 *
 * It lives here, not in mcp-server/tests, because the server it boots reads `examples/`, which the
 * base runs without.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TSX_CLI = join(dirname(createRequire(import.meta.url).resolve('tsx/package.json')), 'dist', 'cli.mjs');
/**
 * The two ways mcp-server runs: from source under tsx, as the README and spec/architecture.md start
 * it, and compiled, as `npm start` and the package's bin do. They find the configuration from
 * different directories (mcp-server/ and mcp-server/dist/). The compiled server looked for the binary
 * in mcp-server/node_modules/.bin/ and the configuration in mcp-server/examples/, neither of which
 * exists, so it failed at once. CI builds dist/ before the suite runs.
 */
const LAUNCHES = [
  { how: 'from source under tsx', args: [TSX_CLI, join(ROOT, 'mcp-server', 'server.ts')] },
  { how: 'compiled, from dist/', args: [join(ROOT, 'mcp-server', 'dist', 'server.js')] },
];
const POD_NAME = 'local-fallback';
/** mcp-server's own startup timeout is 30 s; the tool call gets that and room to provision the pod. */
const CALL_MS = 90_000;

const freePort = async (): Promise<number> => new Promise((done, fail) => {
  const probe = createServer();
  probe.once('error', fail);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address() as AddressInfo;
    probe.close(() => done(port));
  });
});

/** True once nothing accepts a connection at `url`, polled for up to `ms`. */
async function closedWithin(url: string, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const open = await fetch(url, { signal: AbortSignal.timeout(1_000) }).then(r => r.arrayBuffer().then(() => true), () => false);
    if (!open) return true;
    await new Promise(done => setTimeout(done, 250));
  }
  return false;
}

describe.each(LAUNCHES)('mcp-server, run $how, starts its local Solid server', ({ args }) => {
  let workDir = '';
  let rootFilePath = '';
  let baseUrl = '';
  let homePod = '';
  let stderr = '';
  let client: Client | undefined;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'interego-mcp-local-css-'));
    rootFilePath = join(workDir, 'pods');
    const port = await freePort();
    baseUrl = `http://localhost:${port}/`;
    homePod = `${baseUrl}${POD_NAME}/`;
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      // The developer's own pod settings must not choose which server this boots.
      if (value !== undefined && !key.startsWith('CG_')) env[key] = value;
    }
    const transport = new StdioClientTransport({
      command: process.execPath,
      args,
      // Started in the work directory: pods written to the current directory would land there.
      cwd: workDir,
      env: {
        ...env,
        CG_PORT: String(port),
        CG_BASE_URL: baseUrl,
        CG_POD_NAME: POD_NAME,
        CG_CSS_ROOT_FILE_PATH: rootFilePath,
        CG_AGENT_KEY_FILE: join(workDir, 'agent-key.json'),
        // Keep startup network-free, as mcp-server/tests/stdio-serves-both-eras.test.ts does.
        CG_POD_DIRECTORY: '',
        DIRECTORY_URL: '',
      },
      stderr: 'pipe',
    });
    transport.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-200_000); });
    client = new Client({ name: 'local-solid-server-test', version: '1.0.0' });
    await client.connect(transport);
  }, CALL_MS);

  afterAll(async () => {
    try { await client?.close(); }
    finally {
      // Only remove this test's own newly created temporary directory.
      if (workDir && dirname(resolve(workDir)) === resolve(tmpdir()) && basename(workDir).startsWith('interego-mcp-local-css-')) {
        await rm(workDir, { recursive: true, force: true });
      }
    }
  }, CALL_MS);

  it('boots on the first tool call that needs the pod, and the pod answers HTTP', async () => {
    expect(await fetch(baseUrl).then(() => true, () => false), `something already answers at ${baseUrl}`).toBe(false);
    const result = await client!.callTool({ name: 'get_pod_status', arguments: {} }, { timeout: CALL_MS });
    const text = JSON.stringify(result);
    // The failure this was written for, named before anything that would only time out.
    const refused = stderr.split('\n').filter(line => /Could not build the config files|is not a valid component|Could not find \(valid\) component types/.test(line));
    expect(refused, 'the Solid server could not build its configuration').toEqual([]);
    expect(stderr, `the Solid server did not start: ${text}\n${stderr.slice(-3_000)}`).toContain(`CSS ready at ${homePod}`);
    expect(text, text).toContain('CSS: running');
    const root = await fetch(baseUrl, { headers: { accept: 'text/turtle' } });
    expect(root.status).toBe(200);
    await root.arrayBuffer();
    const pod = await fetch(homePod, { headers: { accept: 'text/turtle' } });
    expect(pod.status, 'mcp-server did not provision its home pod').toBe(200);
    await pod.arrayBuffer();
  }, CALL_MS);

  it('keeps the pods in CG_CSS_ROOT_FILE_PATH, not in the directory it was started in', () => {
    expect(existsSync(join(rootFilePath, POD_NAME)), `no ${POD_NAME}/ under ${rootFilePath}`).toBe(true);
    // CSS's file backend writes the pod, and its own .internal/, under its root; the old spawn gave it
    // none, so the root was the current directory, which an MCP client sets to the user's project.
    expect(readdirSync(workDir)).not.toContain(POD_NAME);
    expect(readdirSync(workDir)).not.toContain('.internal');
  });

  it('stops the Solid server when mcp-server goes away', async () => {
    await client!.close();
    client = undefined;
    expect(await closedWithin(baseUrl, 15_000), `the Solid server still answers at ${baseUrl}`).toBe(true);
  }, CALL_MS);
});
