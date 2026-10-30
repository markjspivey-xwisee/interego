/* global chrome */
import { normalizeRelay } from './relay.mjs';
import { relayOrigin } from './native-identity.mjs';
import { identityProviderOrigin } from './native-linking.mjs';

const $ = id => document.getElementById(id);
let state;
let reviewId;
let busy = false;
async function request(type, payload = {}) {
  const account = type.startsWith('NATIVE_') ? {} : { expectedAccountId: state?.activeId };
  const response = await chrome.runtime.sendMessage({ type, ...account, ...payload });
  if (!response?.ok) throw new Error(response?.error ?? 'The wallet did not answer.');
  return response.value;
}
function status(text, error = false) { $('status').textContent = text; $('status').classList.toggle('error', error); }
function el(tag, text, className) { const n = document.createElement(tag); if (text != null) n.textContent = text; if (className) n.className = className; return n; }
async function run(fn) {
  if (busy) return;
  busy = true;
  document.body.classList.add('busy');
  try { await fn(); } catch (e) { status(e.message, true); } finally { busy = false; document.body.classList.remove('busy'); }
}
function showReview(review) {
  reviewId = review?.id;
  $('review').hidden = !review;
  if (!review) return;
  $('review-body').textContent = review.body;
  $('review-destination').replaceChildren();
  const local = state?.accounts.find(a => a.id === state.activeId)?.mode === 'local';
  for (const [label, value] of [['Title', review.title], ['Connection', review.relay], ['Destination', review.destination], [local ? 'Local grant' : 'Agent', review.principal], ['Visibility', local ? 'Private · your local pod' : 'Private · current session agent']]) $('review-destination').append(el('dt', label), el('dd', value));
}
function connectionMode() {
  const local = $('connection-mode').value === 'local';
  $('local-setup').hidden = !local;
  $('relay-label').textContent = local ? 'Secure local bridge address' : 'Interego relay';
  $('connect').textContent = local ? 'Connect local pod' : 'Connect identity ↗';
  $('capture-title').maxLength = local ? 160 : 200;
  if (!state?.accounts.some(a => a.id === state.activeId)) $('identity').textContent = local
    ? 'Approve this browser’s note access in the Interego app.' : 'Sign in with the relay’s passkey, wallet, or key flow.';
}
function renderState(s) {
  state = s;
  $('extension-id').textContent = s.extensionId ?? chrome.runtime.id;
  $('account-select').replaceChildren();
  for (const a of s.accounts) { const option = el('option', a.principal + (a.connected ? '' : ' · sign-in needed')); option.value = a.id; $('account-select').append(option); }
  if (!s.accounts.length) $('account-select').append(el('option', 'No connection yet'));
  $('account-select').value = s.activeId ?? '';
  const account = s.accounts.find(a => a.id === s.activeId);
  $('disconnect').disabled = !account;
  $('identity').replaceChildren();
  if (account) {
    $('relay').value = account.relay;
    $('connection-mode').value = account.mode === 'local' ? 'local' : 'hosted';
    $('identity').append(el('p', account.connected ? account.mode === 'local' ? 'Approved local note connection' : 'Authenticated session agent' : 'Sign-in required', 'identity-label'), el('p', account.principal), el('p', account.podUrl, 'fine'), el('p', /write|notes:create/.test(account.scope) ? 'May read and save private notes' : 'Read context only', 'fine'));
  } else $('identity').textContent = 'Sign in with the relay’s passkey, wallet, or key flow.';
  connectionMode();
  $('receipts').replaceChildren();
  for (const r of s.receipts) {
    const row = el('div', null, 'receipt');
    const labels = { 'read-back': 'Accepted · descriptor read back', accepted: 'Accepted · read-back not confirmed', uncertain: 'Uncertain · inspect pod before retry', refused: 'Refused · no note sent' };
    row.append(el('strong', r.title), el('p', labels[r.status] ?? r.status, 'receipt-status'), el('p', new Date(r.at).toLocaleString(), 'fine'));
    if (r.descriptorUrl) row.append(el('p', r.descriptorUrl, 'fine'));
    $('receipts').append(row);
  }
  if (!s.receipts.length) $('receipts').textContent = 'Your save history will appear here.';
  showReview(s.review);
}
async function refresh() {
  $('descriptor').hidden = true;
  const { entries } = await request('REFRESH');
  $('contexts').replaceChildren();
  for (const entry of entries) {
    const row = el('div', null, 'context-row');
    const title = entry.title || entry.describes?.join(', ') || entry.descriptorUrl || 'Context descriptor';
    const button = el('button', title, 'context-link');
    button.type = 'button';
    button.addEventListener('click', () => run(async () => {
      const d = await request('DESCRIPTOR', { url: entry.descriptorUrl });
      $('descriptor-body').textContent = d.graph?.content || d.turtle || 'No readable content was returned.';
      $('descriptor-heading').textContent = d.kind === 'local-note' ? 'Local note' : 'Descriptor';
      const a = d.authorship;
      $('proof').textContent = a?.authorshipVerified ? `Signature verified by relay. Authority: ${a.signatureAuthority ?? 'not classified'}. Content binding: ${a.contentBinding ?? 'not reported'}.` : d.kind === 'local-note' ? 'Read through your approved local connection. This notes adapter does not return a signed descriptor.' : 'Authorship verification was not established by this response.';
      $('descriptor').hidden = false;
      status('Descriptor opened.');
    }));
    row.append(button, el('p', `${entry.modalStatus ?? 'Context'} · ${entry.validFrom ? new Date(entry.validFrom).toLocaleDateString() : 'No date reported'}`, 'fine'));
    $('contexts').append(row);
  }
  if (!entries.length) $('contexts').textContent = 'This pod returned no recent descriptors.';
}
$('connect-form').addEventListener('submit', event => {
  event.preventDefault();
  if (busy) return;
  let relay;
  try { relay = normalizeRelay($('relay').value); } catch (e) { status(e.message, true); return; }
  // Initiate the permission request directly in this user gesture.
  const permission = chrome.permissions.request({ origins: [`${relay}/*`] });
  run(async () => {
    if (!await permission) throw new Error('Relay access was declined.');
    status('Complete sign-in in the identity window…');
    renderState(await request('CONNECT', { relay, mode: $('connection-mode').value, scope: $('scope').value }));
    await refresh();
    status('Identity connected.');
  });
});
$('connection-mode').addEventListener('change', () => {
  connectionMode();
  $('relay').value = $('connection-mode').value === 'local' ? '' : 'https://relay.interego.xwisee.com';
});
$('copy-extension-id').addEventListener('click', () => run(async () => {
  try { await navigator.clipboard.writeText(chrome.runtime.id); }
  catch { throw new Error('Copy the displayed extension ID into Interego’s browser extension settings.'); }
  status('Extension ID copied. Paste it into Interego’s browser extension settings.');
}));
$('account-select').addEventListener('change', () => run(async () => { renderState(await request('SWITCH', { accountId: $('account-select').value })); $('contexts').textContent = 'Refresh to inspect this identity’s context.'; $('descriptor').hidden = true; status('Identity selected.'); }));
$('refresh').addEventListener('click', () => run(async () => { await refresh(); status('Recent context updated.'); }));
$('capture-form').addEventListener('submit', event => {
  event.preventDefault();
  run(async () => {
    showReview(await request('PREPARE', { title: $('capture-title').value, url: $('capture-url').value, text: $('capture-text').value, purpose: $('purpose').value }));
    $('review').scrollIntoView({ behavior: 'smooth', block: 'center' });
    status('Review the note, identity, and destination. Approval sends this exact text.');
  });
});
$('confirm-save').addEventListener('click', () => run(async () => {
  const id = reviewId;
  showReview(null);
  status('Saving once and checking the returned descriptor…');
  try {
    const saved = await request('SAVE', { reviewId: id });
    $('capture-form').reset();
    status(saved.status === 'read-back' ? 'Private note accepted; descriptor read back.' : 'Private note accepted. Read-back could not be confirmed.');
  } finally { renderState(await request('STATE')); }
}));
$('cancel-review').addEventListener('click', () => run(async () => { await request('CANCEL'); showReview(null); status('Save cancelled.'); }));
$('disconnect').addEventListener('click', () => run(async () => {
  const next = await request('DISCONNECT'); renderState(next);
  $('contexts').textContent = 'Connect a pod to explore its context.'; $('descriptor').hidden = true;
  status(next.disconnect?.local ? next.disconnect.revoked ? 'Local connection forgotten; its OAuth session was revoked.'
    : 'Local connection forgotten. Remote revocation was not confirmed; use Disconnect in Interego to revoke the saved grant.'
    : 'Local connection forgotten. Existing notes and server grants remain at the relay.');
}));

function renderNativeIdentity(value) {
  $('native-identity-status').textContent = value.relays.length ? 'Installed-app sign-in enabled for ' + value.relays.join(', ') + '. Reload an open sign-in page to use it.' : 'Installed-app sign-in is off.';
  $('native-identity-forget').disabled = !value.relays.length;
  const providers = value.providers ?? [];
  $('native-linking-status').textContent = providers.length ? 'Account linking enabled for ' + providers.join(', ') + '. Authenticate freshly on that provider’s dashboard to prepare a link request.' : 'Account linking is off.';
  $('native-linking-forget').disabled = !providers.length;
}
$('native-identity-form').addEventListener('submit', event => {
  event.preventDefault();
  // Request optional host access in the actual form gesture, before any async work.
  let origin;
  try { origin = relayOrigin($('native-identity-relay').value); } catch (error) { status(error.message, true); return; }
  const permission = chrome.permissions.request({ origins: [origin + '/*'] });
  void run(async () => { if (!await permission) throw new Error('Relay access was not granted.'); renderNativeIdentity(await request('NATIVE_CONFIGURE', { relays: [origin] })); status('Local sign-in enabled. Approve website requests in the Interego app.'); });
});
$('native-identity-forget').addEventListener('click', () => run(async () => { renderNativeIdentity(await request('NATIVE_CONFIGURE', { relays: [] })); status('Installed-app sign-in turned off.'); }));
$('native-linking-form').addEventListener('submit', event => {
  event.preventDefault(); if (busy) return;
  let providers;
  try {
    if (!$('native-linking-consent').checked) throw new Error('Confirm that these dashboards may request account linking.');
    const values = $('native-linking-providers').value.trim().split(/\s+/).filter(Boolean);
    if (!values.length || values.length > 4) throw new Error('Choose up to four identity provider origins, one per line.');
    providers = [...new Set(values.map(identityProviderOrigin))];
  } catch (error) { status(error.message, true); return; }
  // Explicit optional-origin access is requested only in this linking form's gesture.
  const permission = chrome.permissions.request({ origins: providers.map(origin => origin + '/*') });
  void run(async () => {
    if (!await permission) throw new Error('Identity provider access was not granted.');
    renderNativeIdentity(await request('NATIVE_CONFIGURE_LINKING', { providers })); $('native-linking-consent').checked = false;
    status('Account linking enabled for the selected dashboards. Freshly authenticate there, then approve the exact account in Interego.');
  });
});
$('native-linking-providers').addEventListener('input', () => { $('native-linking-consent').checked = false; });
$('native-linking-forget').addEventListener('click', () => run(async () => { renderNativeIdentity(await request('NATIVE_CONFIGURE_LINKING', { providers: [] })); status('Dashboard account linking turned off. Existing linked credentials are unchanged.'); }));

await run(async () => {
  renderNativeIdentity(await request('NATIVE_STATE'));
  renderState(await request('STATE'));
  if (state.draft) { for (const [id, key] of [['capture-title', 'title'], ['capture-url', 'url'], ['capture-text', 'text'], ['purpose', 'purpose']]) $(id).value = state.draft[key] ?? ''; }
  if (state.captureNotice) status(state.captureNotice);
  const account = state.accounts.find(a => a.id === state.activeId);
  if (account?.connected) await refresh();
});
