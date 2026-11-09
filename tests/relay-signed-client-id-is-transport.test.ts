/**
 * A relay-signed payload now carries `client_id` (the OAuth client the relay's session was issued
 * to, see `handleSignRequest` in deploy/mcp-relay/server.ts), and every closed list of the relay's
 * own transport fields in this repo has to say so.
 *
 * ── WHY ──────────────────────────────────────────────────────────────────────
 *
 * Several verticals verify a relay-signed request and then refuse any top-level field they do not
 * list, or strip the relay's fields before handing the rest to a closed schema. Each of those lists
 * named exactly the fields the relay set before: `agent_id`, `timestamp`, `subject_pod_url`. A
 * fourth field from the relay turned every one of them into a refusal of every chat agent's
 * request ("Unsupported payload fields", "undeclared fields", "invalid capture setting:
 * client_id", ...), with nothing wrong in the request.
 *
 * So this reads every tracked source file and requires: a line that names all three of the relay's
 * older fields as quoted strings (an allowlist or a strip list) names `'client_id'` too, and a
 * destructuring that sets `subject_pod_url` aside before a rest element sets `client_id` aside too.
 * It also requires that it found the sites it was written against, so a rename cannot leave it
 * checking nothing.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '--', 'applications', 'deploy', 'packages', 'integrations', 'examples', 'mcp-server'],
  { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  .split('\n')
  .filter((f) => /\.(?:ts|mts|js|mjs)$/.test(f))
  .filter((f) => !/(?:^|\/)(?:tests?|node_modules|dist|build|build-ts|evidence)\//.test(f) && !/\.test\.[cm]?[jt]s$/.test(f));

interface Site { readonly file: string; readonly line: number; readonly text: string }
const lists: Site[] = [];
const destructurings: Site[] = [];
for (const file of files) {
  let text: string;
  try { text = readFileSync(join(ROOT, file), 'utf8'); } catch { continue; }
  if (!text.includes('subject_pod_url')) continue;
  text.split('\n').forEach((line, i) => {
    const site = { file, line: i + 1, text: line.trim() };
    if (["'agent_id'", "'timestamp'", "'subject_pod_url'"].every((q) => line.includes(q))) lists.push(site);
    if (/\bsubject_pod_url:\s*_\w*/.test(line) && /\.\.\.\w+/.test(line)) destructurings.push(site);
  });
}

describe("the relay's client_id is a transport field wherever the relay's fields are listed", () => {
  it('finds the closed lists and strip lists it was written against', () => {
    const at = (path: string): boolean => lists.some((s) => s.file === path);
    expect(at('applications/agentic-performance-practice/compatibility/private-performance-routes.ts')).toBe(true);
    expect(at('applications/agentic-performance-practice/compatibility/foxxi-performance-routes.ts')).toBe(true);
    expect(at('applications/foxxi-content-intelligence/src/directory-actions.ts')).toBe(true);
    expect(at('applications/foxxi-content-intelligence/src/i2idlx-agent-sessions.ts')).toBe(true);
    expect(at('applications/foxxi-content-intelligence/src/lti-own-reconciliation.ts')).toBe(true);
    expect(at('applications/foxxi-content-intelligence/src/lti-own-reconciliation-http.ts')).toBe(true);
    expect(at('applications/work-redesign/bridge/ui.ts')).toBe(true);
    expect(at('deploy/mcp-relay/server.ts')).toBe(true);
    expect(destructurings.filter((s) => s.file === 'applications/foxxi-content-intelligence/bridge/server.ts').length).toBeGreaterThanOrEqual(2);
  });

  it("every list naming agent_id, timestamp and subject_pod_url also names 'client_id'", () => {
    const missing = lists.filter((s) => !s.text.includes("'client_id'")).map((s) => `${s.file}:${s.line}: ${s.text.slice(0, 160)}`);
    expect(missing).toEqual([]);
  });

  it('every destructuring that sets subject_pod_url aside before a rest element sets client_id aside too', () => {
    const missing = destructurings.filter((s) => !/\bclient_id:\s*_\w*/.test(s.text)).map((s) => `${s.file}:${s.line}: ${s.text.slice(0, 160)}`);
    expect(missing).toEqual([]);
  });
});
