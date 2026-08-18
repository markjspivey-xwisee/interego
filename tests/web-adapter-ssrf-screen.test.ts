/**
 * The web source adapter fetches a caller-supplied URL and RETURNS ITS BODY.
 *
 * ── ★★ WHY THIS FILE EXISTS ────────────────────────────────────────────────────────────────
 *
 * `web.cat` took a `uri` straight from its caller, checked only that it began with `http`, and
 * fetched it server-side following redirects. That is a blind SSRF primitive — except it is not even
 * blind, because the adapter hands the response body back. `http://169.254.169.254/latest/meta-data/`
 * passes a scheme test.
 *
 * A system audit found the SSRF screen implemented inside one vertical, re-implemented at the relay,
 * and MISSING here. That is the direction this class always travels: each application guards the
 * hole it already fell into. The screen now lives in the substrate and this adapter uses it.
 *
 * ★ These assert the REFUSAL, which is the security property. They deliberately do not assert on a
 * successful public fetch — a test that reaches the network to prove a guard lets traffic through
 * would be slower, flakier, and would prove the wrong half.
 */

import { describe, it, expect } from 'vitest';
import { webAdapter } from '../applications/organizational-working-memory/source-adapters/web.js';

async function cat(uri: string): Promise<{ ok?: boolean; reason?: string }> {
  return await webAdapter.navigate('cat', { uri }) as { ok?: boolean; reason?: string };
}

describe('web.cat screens caller-supplied URLs before fetching them', () => {
  it('★ refuses the cloud metadata endpoint', async () => {
    const r = await cat('http://169.254.169.254/latest/meta-data/');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/refused/i);
  });

  it('★ refuses loopback and private ranges', async () => {
    for (const u of [
      'http://127.0.0.1/',
      'http://localhost:3456/admin',
      'http://10.0.0.5/internal',
      'http://192.168.1.1/',
      'http://172.16.0.1/',
      'http://[::1]/',
    ]) {
      const r = await cat(u);
      expect(r.ok, `should have refused ${u}`).toBe(false);
      expect(r.reason, `should have refused ${u}`).toMatch(/refused/i);
    }
  });

  it('still refuses a non-http scheme, as before', async () => {
    const r = await cat('file:///etc/passwd');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/http\(s\) URI/);
  });

  it('the refusal is distinguishable from a fetch failure', async () => {
    // A caller — and an operator reading logs — needs to tell "we would not go there" from "we went
    // and it broke". Collapsing them hides a misconfigured allowlist behind apparent flakiness.
    const refused = await cat('http://169.254.169.254/');
    expect(refused.reason).toMatch(/^refused:/);
    expect(refused.reason).not.toMatch(/^fetch failed:/);
  });
});
