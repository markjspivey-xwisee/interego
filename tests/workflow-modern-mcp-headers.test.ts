/**
 * Every workflow that probes a deployed MCP endpoint in the 2026-07-28 era sends
 * MCP-Protocol-Version beside Mcp-Method.
 *
 * WHY. @modelcontextprotocol/server 2.3 and later refuses a modern request without
 * that header (-32020, HTTP 400), as the spec requires. The release workflow's live
 * check of the I2IDL-X MCP App sent `Mcp-Method` alone, so it passed against the image
 * it was written for and would fail against the first image built on the newer SDK —
 * after the deploy, in the one check meant to prove the deploy. The repo's own tests
 * were updated when the SDK moved; a workflow is not a test, so nothing ran it.
 *
 * The rule is checked per line because that is how every probe here builds its headers:
 * one object literal, the modern pair spread in together.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKFLOWS = fileURLToPath(new URL('../.github/workflows/', import.meta.url));

describe('workflow MCP probes send the headers a 2026-07-28 request requires', () => {
  const files = readdirSync(WORKFLOWS).filter(f => /\.ya?ml$/.test(f));

  it('finds the workflows (a renamed directory must not pass this vacuously)', () => {
    expect(files.length).toBeGreaterThan(0);
    const probing = files.filter(f => /['"]Mcp-Method['"]\s*:/i.test(readFileSync(join(WORKFLOWS, f), 'utf8')));
    expect(probing).toContain('i2idlx-v93-release.yml');
  });

  it('every line that sets Mcp-Method also sets MCP-Protocol-Version', () => {
    const missing: string[] = [];
    for (const f of files) {
      readFileSync(join(WORKFLOWS, f), 'utf8').split('\n').forEach((line, i) => {
        if (/['"]Mcp-Method['"]\s*:/i.test(line) && !/['"]MCP-Protocol-Version['"]\s*:/i.test(line)) {
          missing.push(`${f}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(missing).toEqual([]);
  });
});
