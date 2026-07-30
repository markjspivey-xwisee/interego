#!/usr/bin/env node
/**
 * The holodeck MCP shim starts and answers a real client.
 *
 * ★ WHY. This shim signs and POSTs to the PRODUCTION RELAY with a per-agent wallet, and
 * no CI workflow has ever covered `examples/**`. When the v1 `@modelcontextprotocol/sdk`
 * was removed from the repo during the v2 migration, its three imports stopped
 * resolving — the file would have crashed at startup with MODULE_NOT_FOUND, and nothing
 * would have said so until someone ran a holodeck scenario.
 *
 * `node --check` would NOT have caught it: the syntax was fine, the module graph was
 * not. Only booting the thing catches a bad import, which is the whole point of this
 * file being a boot test rather than a lint.
 *
 * Run: node examples/holodeck/mcp-shim-boots.test.mjs
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const shim = resolve(here, 'lib', 'mcp-shim.mjs');

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failures++; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
};

// A throwaway key: the shim needs a syntactically valid wallet to construct, and this
// test never signs anything or reaches the network.
const child = spawn(process.execPath, [shim], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: {
    ...process.env,
    INTEREGO_WALLET_KEY: `0x${'11'.repeat(32)}`,
    INTEREGO_DID: 'did:ethr:0x0000000000000000000000000000000000000001',
    INTEREGO_LABEL: 'ci-boot-probe',
  },
});

let out = '', err = '';
child.stdout.on('data', d => { out += d; });
child.stderr.on('data', d => { err += d; });

const frames = () => out.split('\n').filter(Boolean)
  .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

const waitFor = async (id, ms = 15000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const hit = frames().find(f => f.id === id);
    if (hit) return hit;
    if (child.exitCode !== null) return undefined;
    await new Promise(r => setTimeout(r, 50));
  }
  return undefined;
};

const send = m => child.stdin.write(`${JSON.stringify(m)}\n`);

console.log('\nholodeck mcp-shim: boots and serves');

try {
  send({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'ci', version: '1' } },
  });
  const init = await waitFor(1);
  check('the shim starts (a broken import would exit here)', child.exitCode === null,
    `exit ${child.exitCode}: ${err.trim().split('\n').slice(-2).join(' | ')}`);
  check('it answers initialize', !!init?.result?.protocolVersion, String(init?.result?.protocolVersion));

  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const list = await waitFor(2);
  const names = (list?.result?.tools ?? []).map(t => t.name);
  check('it serves its tool surface', names.length > 0, JSON.stringify(names));
  // The tools this shim exists to expose. A silently emptied surface would otherwise
  // still "pass" a bare length check after a bad refactor.
  for (const expected of ['publish_context', 'discover_context', 'whoami']) {
    check(`…including ${expected}`, names.includes(expected), names.join(', '));
  }
} finally {
  child.kill();
}

console.log(failures === 0 ? '\nAll holodeck shim boot checks passed.\n' : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
