/**
 * Live Jev. Declared, not detected: JEV_LIVE=1 makes an unreachable or failing model a red
 * test rather than a silently skipped one (the lrs-adapter lesson in the Interego repo).
 * Without the declaration the suite reports the skip visibly.
 */
import { describe, expect, it } from 'vitest';
import { HttpJevClient, resolveApiKey } from '../src/jev-client.js';
import { navigate } from '../src/judgments/navigate.js';
import { inventory } from '../src/repo.js';

const declared = process.env['JEV_LIVE'] === '1';
const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

describe.skipIf(!declared)('live Jev (JEV_LIVE=1)', () => {
  it('navigates this package: a SHACL question lands on shacl-lite', async () => {
    expect(resolveApiKey(), 'JEV_LIVE=1 was declared but TYPESAFE_API_KEY is not available').toBeTruthy();
    const jev = new HttpJevClient();
    const inv = inventory(root, { includeHeads: true });
    const j = await navigate(jev, inv, { task: 'validate a JSON payload against a SHACL property shape and report violations' });
    expect(j.model).toMatch(/^jev-/);
    expect(j.files.slice(0, 3).map((f) => f.path)).toContain('src/shacl-lite.ts');
    expect(j.usage.input_tokens).toBeGreaterThan(0);
  }, 60_000);
});

if (!declared) {
  describe('live Jev (not declared)', () => {
    it.skip('set JEV_LIVE=1 to run the live model test; it then FAILS if the model is unreachable', () => {});
  });
}
