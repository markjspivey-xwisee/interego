import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { dashboardInboxScript } from '../dashboard-inbox.js';

const pages: JSDOM[] = [];
afterEach(() => { for (const page of pages.splice(0)) page.window.close(); });
async function render(answer: unknown, failure?: string) {
  const page = new JSDOM('<!doctype html><div id="inbox"></div><section id="pc-key"><p data-state="verified">Existing credential verified.</p><button>Continue in Interego on this PC</button></section>', { url: 'https://identity.example/dashboard', runScripts: 'outside-only' }); pages.push(page);
  page.window.sessionStorage.setItem('cg.token', 'fixture-identity-session');
  const requests: Array<{ base: string; path: string }> = [];
  Object.defineProperties(page.window, {
    RELAY_BASE: { value: 'https://relay.example' },
    api: { value: async (base: string, path: string) => { requests.push({ base, path }); if (failure) throw new Error(failure); return answer; } },
  });
  await page.window.eval(dashboardInboxScript() + '\nrenderDashboardInbox(document.getElementById("inbox"));');
  return { page, requests, card: page.window.document.getElementById('inbox')! };
}
test('dashboard uses its dedicated identity-session inbox route without a caller pod address', async () => {
  const { card, requests } = await render({ count: 0, totalOnPod: 7, events: [], hint: 'No new descriptors.' });
  assert.deepEqual(requests, [{ base: 'https://relay.example', path: '/dashboard/inbox?limit=20' }]);
  assert.match(card.textContent!, /0 \/ 7/); assert.match(card.textContent!, /No new descriptors/);
  const source = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
  assert.ok(source.includes('${dashboardInboxScript()}')); assert.ok(source.includes('await renderDashboardInbox(inboxCard)'));
  assert.ok(!source.includes("api(RELAY_BASE, '/inbox?pod='"));
});
test('descriptor URLs, dates, trust labels and empty-state hints cannot insert markup', async () => {
  const payload = '<img src=x onerror="window.injected=true"><script>window.injected=true</script>';
  const { card, page } = await render({ count: 1, totalOnPod: 1, events: [{ descriptorUrl: payload, validFrom: payload, trustLevel: payload, modalStatus: payload }] });
  assert.ok(card.textContent!.includes(payload)); assert.equal(card.querySelectorAll('img,script,svg').length, 0);
  assert.equal(page.window.document.querySelectorAll('.pill').length, 0); assert.equal((page.window as unknown as { injected?: unknown }).injected, undefined);
  const empty = await render({ count: 0, totalOnPod: 0, events: [], hint: payload });
  assert.ok(empty.card.textContent!.includes(payload)); assert.equal(empty.card.querySelectorAll('img,script,svg').length, 0);
});
test('inbox failures render as text and do not sign out or cancel PC-key verification', async () => {
  const message = '<svg onload="window.injected=true">Service unavailable</svg>';
  const { page, card } = await render(null, message);
  assert.ok(card.textContent!.includes(message)); assert.equal(card.querySelectorAll('svg,script').length, 0);
  assert.equal(page.window.sessionStorage.getItem('cg.token'), 'fixture-identity-session');
  assert.equal(page.window.document.querySelector('#pc-key p')!.getAttribute('data-state'), 'verified');
  assert.equal(page.window.document.querySelector('#pc-key p')!.textContent, 'Existing credential verified.');
  assert.equal((page.window.document.querySelector('#pc-key button') as HTMLButtonElement).disabled, false);
  const script = dashboardInboxScript();
  assert.ok(!/clearToken|signOut|local-identity\/link|sessionStorage/.test(script));
});
