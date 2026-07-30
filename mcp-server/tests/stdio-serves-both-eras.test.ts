/**
 * The stdio server actually serves a real MCP client — in both protocol eras.
 *
 * ★ WHY. Nothing in this package ever exercised server.ts. tool-publish-context.test.ts
 * deliberately does not import it, so the six request handlers had no test at all, and
 * `npm run build` (which is the only thing that tsc-checked them) ran solely inside
 * publish-npm.yml on a v* tag. A broken handler registration would have shipped.
 *
 * That mattered more than usual for the v2 migration, because the change was not a
 * rename: `serveStdio` takes a FACTORY and calls it once per connection *plus* once
 * for an optimistic `server/discover` probe, closing the probe instance if the client
 * falls back to the older handshake. Registering handlers onto one module-level server
 * would typecheck, start, and answer `tools/list` — and then fail intermittently, only
 * against clients that probe and fall back.
 *
 * So this test drives the real binary over real stdio with the real SDK client, in
 * both negotiation modes:
 *
 *   - `legacy` (the SDK client's DEFAULT): the plain 2025 `initialize` sequence.
 *   - `auto`: probes with `server/discover` first, then falls back if needed.
 *
 * BEHAVIOURAL — it spawns the server as a subprocess. No mocks, no doubles: a harness
 * that stood in for the transport could not have caught the factory problem at all.
 */
import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(here, '..', 'server.ts');

// Resolve tsx through node's own resolution rather than a relative walk, so this
// keeps working wherever the workspace hoists it.
const require_ = createRequire(import.meta.url);
const tsxCli = join(dirname(require_.resolve('tsx/package.json')), 'dist', 'cli.mjs');

/** Spawn the server under tsx and connect. `mode` selects era negotiation. */
async function connect(mode: 'legacy' | 'auto') {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [tsxCli, serverPath],
    env: {
      ...process.env,
      // Keep startup network-free: main() only reaches out when this is set.
      CG_POD_DIRECTORY: '',
      DIRECTORY_URL: '',
    } as Record<string, string>,
    stderr: 'ignore',
  });
  const client = new Client({ name: 'stdio-era-test', version: '1.0.0' });
  await client.connect(transport, mode === 'auto' ? { versionNegotiation: { mode: 'auto' } } : undefined);
  return { client, transport };
}

describe('the stdio server serves a real client in both eras', () => {
  for (const mode of ['legacy', 'auto'] as const) {
    it(`answers tools/list, resources/list and prompts/list in ${mode} mode`, async () => {
      const { client } = await connect(mode);
      try {
        const tools = await client.listTools();
        expect(tools.tools.length, 'a server that advertises no tools is not serving').toBeGreaterThan(0);

        // Every declared input schema must be an object schema — the one thing the
        // spec requires of inputSchema, and the thing the old
        // `inputSchema: object` cast erased.
        for (const t of tools.tools) {
          expect(t.inputSchema, `${t.name} has no inputSchema`).toBeTruthy();
          expect((t.inputSchema as { type?: string }).type, `${t.name} inputSchema.type`).toBe('object');
        }

        const resources = await client.listResources();
        expect(Array.isArray(resources.resources)).toBe(true);

        const prompts = await client.listPrompts();
        expect(Array.isArray(prompts.prompts)).toBe(true);
      } finally {
        await client.close();
      }
    }, 120_000);
  }

  // ★ This one has to be raw JSON-RPC, and the reason is worth recording.
  //
  // The obvious version of this test — connect twice with the SDK client in `auto`
  // mode — PASSES against a deliberately broken module-level singleton, so it proves
  // nothing. On the SDK's own StdioClientTransport the `auto` probe is documented to
  // run "on a short-lived sibling process spawned from the same parameters", so each
  // process gets its own singleton and the in-process probe-discard path is never
  // reached. I verified that: mutating buildServer() into a singleton left all three
  // client-driven tests green.
  //
  // The path that actually discards an instance is `server/discover` followed by
  // `initialize` on ONE connection, which is what a custom or subclassed stdio
  // transport does. serveStdio answers the discover with a probe instance and then
  // closes it (`discardProbeInstance` -> `instance.product.close()`) when the client
  // falls back. Only by driving that sequence down a single pipe does the singleton
  // mistake become visible.
  it('discovers then falls back on ONE connection, and still serves tools afterwards', async () => {
    const { spawn } = await import('node:child_process');
    const child = spawn(process.execPath, [tsxCli, serverPath], {
      stdio: ['pipe', 'pipe', 'ignore'],
      env: { ...process.env, CG_POD_DIRECTORY: '', DIRECTORY_URL: '' },
    });

    const seen: Array<Record<string, any>> = [];
    let buffer = '';
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try { seen.push(JSON.parse(line)); } catch { /* server log noise, not a frame */ }
      }
    });

    const send = (msg: Record<string, unknown>) => child.stdin.write(`${JSON.stringify(msg)}\n`);
    const waitFor = async (id: number, ms = 20_000) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        const hit = seen.find(m => m.id === id);
        if (hit) return hit;
        await new Promise(r => setTimeout(r, 50));
      }
      return undefined;
    };

    try {
      // 1. Probe the modern era. The `_meta` envelope is what makes this a MODERN
      //    request — a claim-less `server/discover` classifies as legacy, so no probe
      //    instance is built and nothing is ever discarded. (I checked: without the
      //    envelope this test passes against a deliberately broken singleton.)
      send({
        jsonrpc: '2.0', id: 1, method: 'server/discover',
        params: {
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      });
      const discovered = await waitFor(1);
      expect(discovered, 'server/discover went unanswered on the opening exchange').toBeTruthy();
      expect(discovered?.result?.supportedVersions, 'the probe was not served as a modern discover')
        .toContain('2026-07-28');

      // 2. Fall back to the 2025 handshake. This is what makes serveStdio DISCARD and
      //    close the probe instance it just built.
      send({
        jsonrpc: '2.0', id: 2, method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'raw', version: '1' } },
      });
      const initialized = await waitFor(2);
      expect(initialized?.result?.protocolVersion, 'the fallback initialize was not served').toBeTruthy();
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });

      // 3. The connection must still work. Under a shared module-level server, the
      //    probe's close tore down the very instance this request needs.
      send({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} });
      const listed = await waitFor(3);
      expect(listed, 'tools/list went unanswered after the probe was discarded').toBeTruthy();
      expect(listed?.error, `tools/list errored after the discard: ${JSON.stringify(listed?.error)}`).toBeUndefined();
      expect(listed?.result?.tools?.length, 'no tools after the probe was discarded').toBeGreaterThan(0);
    } finally {
      child.kill();
    }
  }, 120_000);
});
