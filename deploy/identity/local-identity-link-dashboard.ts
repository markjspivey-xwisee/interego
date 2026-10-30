/** Dashboard-only owner flow. Bearer and human proofs stay on the identity origin. */
export function localIdentityLinkDashboard(): string {
  return String.raw`
<section id="interego-link-settings" class="card full" style="margin-top:18px" aria-labelledby="interego-link-title">
  <h2 id="interego-link-title">Add this PC key to your existing account</h2>
  <p>This adds a sign-in method to the account you are using here. Your existing app data and hosted pod stay with the same account.</p>
  <p class="hint">First create or restore your PC key in the installed Interego app. Enable this identity site for account linking in Interego Wallet. Then verify an existing passkey or wallet below, and compare the account and code in Interego on this PC.</p>
  <button id="interego-link-load" class="copy" type="button" style="margin-top:14px">Choose an existing passkey or wallet</button>
  <div id="interego-link-methods" hidden style="margin-top:14px">
    <label for="interego-link-method">Verify a sign-in method already on this account</label>
    <select id="interego-link-method" style="display:block;width:100%;margin:8px 0 12px;padding:9px;background:#0a0a0f;color:#e0e0e8;border:1px solid #3a3a4a;border-radius:6px"></select>
    <label style="display:flex;gap:8px;align-items:flex-start"><input id="interego-link-consent" type="checkbox"><span>I am signed into the existing account I want to keep. I want to add this PC key as another way to sign in.</span></label>
    <button id="interego-link-verify" class="copy" type="button" disabled style="margin-top:12px">Verify existing credential</button>
  </div>
  <details id="interego-link-wallet-details" hidden style="margin-top:12px"><summary>Exact wallet verification message</summary><pre id="interego-link-wallet-message" style="white-space:pre-wrap;overflow-wrap:anywhere"></pre></details>
  <p id="interego-link-progress" class="hint" role="status" style="margin-top:12px">Sign into your existing account before starting. Creating a new account is not required.</p>
  <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">
    <button id="interego-local-identity-link" class="copy" type="button" disabled>Continue in Interego on this PC</button>
    <button id="interego-link-cancel" class="copy" type="button" disabled>Cancel this request</button>
  </div>
  <p id="interego-local-identity-link-status" class="hint" role="status">After verification, Interego Wallet will let you continue to the installed app. You will still approve the exact existing account there.</p>
</section>
<script>
(() => {
  'use strict';
  const el = id => document.getElementById(id);
  const load = el('interego-link-load'), methods = el('interego-link-methods'), select = el('interego-link-method');
  const consent = el('interego-link-consent'), verify = el('interego-link-verify'), cancel = el('interego-link-cancel');
  const button = el('interego-local-identity-link'), status = el('interego-local-identity-link-status'), progress = el('interego-link-progress');
  const tokenPattern = /^[A-Za-z0-9_-]{43}$/, handoffPattern = /^interego-link:v1:[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/;
  const choices = new Map(); let methodsToken; let loading = false; let active; let generation = 0;
  const token = () => typeof getToken === 'function' ? getToken() : null;
  const message = (text, error = false) => { progress.textContent = text; progress.className = error ? 'err' : 'hint'; progress.setAttribute('role', error ? 'alert' : 'status'); };
  function controls() {
    load.disabled = loading || !!active; select.disabled = loading || !!active; consent.disabled = loading || !!active;
    verify.disabled = loading || !!active || !consent.checked || !choices.has(select.value) || !methodsToken || token() !== methodsToken;
    cancel.disabled = !active;
  }
  function clearCapability() { button.disabled = true; delete button.dataset.handoffCode; delete button.dataset.expiresAt; }
  function identityBase() {
    const base = new URL(IDENTITY_BASE);
    if (base.origin !== location.origin || base.href !== base.origin + '/' || base.protocol !== 'https:') throw new Error('Open these account settings on the identity provider’s HTTPS address.');
    return base.origin;
  }
  async function api(path, body, signal) {
    const bearer = token(); if (!bearer) throw new Error('Sign into your existing account above, then try again.');
    const abort = new AbortController(), stop = () => abort.abort(); const timer = setTimeout(stop, 15_000);
    signal?.addEventListener('abort', stop, { once: true }); if (signal?.aborted) stop();
    try {
      const response = await fetch(identityBase() + '/local-identity/link/' + path, {
        method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', signal: abort.signal,
        headers: { Accept: 'application/json', Authorization: 'Bearer ' + bearer, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok || response.redirected || !(response.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) throw new Error('This account could not verify the request. Sign in again and start a new request.');
      const reader = response.body?.getReader(); if (!reader) throw new Error('The account service did not answer. Try again.');
      const chunks = []; let size = 0;
      try {
        for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > 64 * 1024) throw new Error('The account service returned an invalid response.'); chunks.push(next.value); }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      const result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('The account service returned an invalid response.');
      return result;
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', stop); }
  }
  function end(text, notify = true) {
    const previous = active; active = undefined; generation++; clearCapability(); consent.checked = false;
    if (previous) {
      previous.abort.abort(); clearTimeout(previous.timer); previous.popup?.close();
      if (notify && token() === previous.token) {
        const body = previous.pendingId ? { pendingId: previous.pendingId } : previous.stepUpId ? { stepUpId: previous.stepUpId } : undefined;
        if (body) void api('cancel', body).catch(() => {});
      }
    }
    if (text) message(text); controls();
  }
  function current(flow) {
    if (active !== flow || flow.generation !== generation || flow.abort.signal.aborted || token() !== flow.token) throw new Error('This account or request changed. Sign into the account you want to keep and start again.');
  }
  function expires(value) {
    const time = Date.parse(value);
    if (!Number.isFinite(time) || time <= Date.now() || time > Date.now() + 125_000) throw new Error('This request expired. Start again.');
    return time;
  }
  function arm(flow, expiry) {
    clearTimeout(flow.timer); flow.timer = setTimeout(() => { if (active === flow) end('This two-minute request ended. Verify an existing credential to start again.'); }, Math.max(1, expiry - Date.now()));
  }
  function from64(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,2048}$/.test(value)) throw new Error('The passkey request could not be verified.');
    return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)), c => c.charCodeAt(0));
  }
  function to64(value) {
    return btoa(Array.from(new Uint8Array(value), b => String.fromCharCode(b)).join('')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function installCapability(flow, ready) {
    current(flow);
    if (!handoffPattern.test(ready.handoffCode) || !tokenPattern.test(ready.pendingId)
      || ready.handoffCode.slice('interego-link:v1:'.length).split('.')[0] !== ready.pendingId) throw new Error('The PC-key request could not be verified.');
    const expiry = expires(ready.expiresAt); flow.pendingId = ready.pendingId; flow.stepUpId = undefined; flow.popup?.close(); flow.popup = undefined; arm(flow, expiry);
    delete status.dataset.nativeState; button.dataset.expiresAt = ready.expiresAt; button.dataset.handoffCode = ready.handoffCode;
    message('Existing credential verified. Continue in Interego on this PC, then check the existing account, PC key fingerprint and matching code.');
    // The wallet extension enables this button; a website cannot open native messaging itself.
    controls();
  }
  async function pause(flow) {
    const interval = flow.pollInterval || 750; flow.pollInterval = Math.min(interval * 2, 5000);
    await new Promise((resolve, reject) => {
      const stop = () => { clearTimeout(timer); reject(new Error('Request cancelled.')); };
      const timer = setTimeout(() => { flow.abort.signal.removeEventListener('abort', stop); resolve(); }, interval);
      flow.abort.signal.addEventListener('abort', stop, { once: true }); if (flow.abort.signal.aborted) stop();
    });
  }
  async function passkey(flow, prepared, selected) {
    if (prepared.stepUpUrl !== undefined) {
      const popupUrl = new URL(prepared.stepUpUrl);
      if (!flow.popup || popupUrl.origin !== selected.value || popupUrl.protocol !== 'https:' || popupUrl.pathname !== '/local-identity/link-step-up'
        || popupUrl.search || popupUrl.username || popupUrl.password || !/^#interego-link-step-up:v1:[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/.test(popupUrl.hash)
        || popupUrl.hash.slice('#interego-link-step-up:v1:'.length).split('.')[0] !== flow.stepUpId) throw new Error('The original passkey site could not be verified.');
      flow.popup.location.replace(popupUrl.href); message('Verify your existing passkey in the window for ' + selected.value + '. This page will continue when verification finishes.');
      for (;;) {
        await pause(flow);
        current(flow); const result = await api('step-up/result', { stepUpId: flow.stepUpId }, flow.abort.signal); current(flow);
        if (result.state === 'ready') { installCapability(flow, result); return; }
        if (result.state !== 'waiting') throw new Error('Passkey verification ended. Start a new request.');
      }
    }
    if (selected.value !== location.origin || !navigator.credentials?.get || !prepared.options || prepared.options.userVerification !== 'required') throw new Error('Use this existing passkey on its original sign-in site.');
    const options = prepared.options;
    if (typeof options.rpId !== 'string' || !(location.hostname === options.rpId || location.hostname.endsWith('.' + options.rpId))
      || !Array.isArray(options.allowCredentials) || !options.allowCredentials.length || options.allowCredentials.length > 64) throw new Error('The passkey request could not be verified.');
    message('Confirm your existing passkey to authorize adding a PC sign-in key to this account.');
    const assertion = await navigator.credentials.get({ signal: flow.abort.signal, publicKey: { challenge: from64(options.challenge), rpId: options.rpId,
      allowCredentials: options.allowCredentials.map(item => ({ type: 'public-key', id: from64(item.id), ...(Array.isArray(item.transports) ? { transports: item.transports } : {}) })), userVerification: 'required', timeout: 120_000 } });
    current(flow); if (!assertion || assertion.type !== 'public-key') throw new Error('No passkey was verified. Start again.');
    const response = { id: assertion.id, rawId: to64(assertion.rawId), type: assertion.type, response: { authenticatorData: to64(assertion.response.authenticatorData),
      clientDataJSON: to64(assertion.response.clientDataJSON), signature: to64(assertion.response.signature), userHandle: assertion.response.userHandle ? to64(assertion.response.userHandle) : null },
      clientExtensionResults: assertion.getClientExtensionResults ? assertion.getClientExtensionResults() : {} };
    const ready = await api('start', { stepUpId: flow.stepUpId, response }, flow.abort.signal); current(flow); installCapability(flow, ready);
  }
  load.addEventListener('click', async () => {
    if (loading || active) return; loading = true; methodsToken = undefined; methods.hidden = true; consent.checked = false; choices.clear(); select.replaceChildren(); controls();
    try {
      const began = token(); const result = await api('methods'); if (!began || token() !== began) throw new Error('Your account changed. Sign in and try again.');
      if (!Array.isArray(result.passkeyOrigins) || !Array.isArray(result.walletAddresses) || result.passkeyOrigins.length + result.walletAddresses.length > 64) throw new Error('Existing sign-in methods could not be checked.');
      const add = (method, value, label) => { const id = method + '-' + choices.size; choices.set(id, { method, value }); const option = document.createElement('option'); option.value = id; option.textContent = label; select.append(option); };
      for (const value of [...new Set(result.passkeyOrigins)]) { const url = new URL(value); if (url.protocol !== 'https:' || url.origin !== value) throw new Error('An existing passkey site could not be verified.'); add('passkey', value, 'Passkey at ' + value); }
      for (const value of [...new Set(result.walletAddresses)]) { if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error('An existing wallet could not be verified.'); add('wallet', value, 'Wallet ' + value); }
      methodsToken = began; methods.hidden = !choices.size;
      message(choices.size ? 'Choose a credential already on this account, then verify it again before adding this PC key.' : 'This account needs an existing passkey or wallet before a PC key can be added. Keep using your existing account sign-in method.');
    } catch (error) { choices.clear(); select.replaceChildren(); methods.hidden = true; message(error.message || 'Existing sign-in methods could not be checked.', true); }
    finally { loading = false; controls(); }
  });
  select.addEventListener('change', () => { consent.checked = false; controls(); }); consent.addEventListener('change', controls);
  verify.addEventListener('click', async () => {
    if (active || loading || !consent.checked || !choices.has(select.value) || token() !== methodsToken) return;
    const selected = choices.get(select.value), flow = { token: token(), generation: ++generation, abort: new AbortController() }; active = flow; clearCapability(); controls();
    try {
      let input = { method: selected.method };
      if (selected.method === 'passkey') {
        input.rpOrigin = selected.value;
        if (selected.value !== location.origin) {
          // Open while the user's click is active, then sever the opener before navigation.
          flow.popup = window.open('about:blank', '_blank', 'popup,width=560,height=720');
          if (!flow.popup) throw new Error('Allow the verification popup for your original passkey site, then try again.');
          flow.popup.opener = null;
        }
      } else {
        if (!window.ethereum?.request) throw new Error('Open the wallet already registered to this account, then try again.');
        const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' }); current(flow);
        if (!Array.isArray(accounts) || !accounts.some(address => typeof address === 'string' && address.toLowerCase() === selected.value.toLowerCase())) throw new Error('Switch your wallet to the existing address shown above, then try again.');
        const chain = await window.ethereum.request({ method: 'eth_chainId' }); current(flow);
        if (typeof chain !== 'string' || !/^0x[0-9a-fA-F]{1,13}$/.test(chain) || !Number.isSafeInteger(parseInt(chain, 16)) || parseInt(chain, 16) <= 0) throw new Error('The wallet network could not be checked.');
        input.address = selected.value; input.chainId = parseInt(chain, 16);
      }
      const prepared = await api('prepare', input, flow.abort.signal); current(flow);
      if (prepared.version !== 1 || prepared.method !== selected.method || !tokenPattern.test(prepared.stepUpId)) throw new Error('The credential verification could not be prepared.');
      flow.stepUpId = prepared.stepUpId; arm(flow, expires(prepared.expiresAt));
      if (selected.method === 'passkey') await passkey(flow, prepared, selected);
      else {
        if (typeof prepared.message !== 'string' || !prepared.message || prepared.message.length > 8192 || typeof prepared.address !== 'string' || prepared.address.toLowerCase() !== selected.value.toLowerCase()) throw new Error('The wallet verification message could not be checked.');
        el('interego-link-wallet-details').hidden = false; el('interego-link-wallet-message').textContent = prepared.message;
        message('Review the exact account-link message in your existing wallet before signing.');
        const hex = '0x' + Array.from(new TextEncoder().encode(prepared.message), byte => byte.toString(16).padStart(2, '0')).join('');
        const signature = await window.ethereum.request({ method: 'personal_sign', params: [hex, prepared.address] }); current(flow);
        if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{128,130}$/.test(signature)) throw new Error('The wallet did not return a valid verification.');
        const ready = await api('start', { stepUpId: flow.stepUpId, signature }, flow.abort.signal); current(flow); installCapability(flow, ready);
      }
    } catch (error) { if (active === flow) { end('', true); message(error.message || 'Verification was cancelled. Start again when ready.', true); } }
  });
  cancel.addEventListener('click', () => end('Request cancelled. No new request will be sent to your PC.'));
  const nativeState = new MutationObserver(() => {
    if (!active || !['linked', 'denied', 'expired', 'failed'].includes(status.dataset.nativeState)) return;
    const linked = status.dataset.nativeState === 'linked'; end('', !linked); message(linked ? 'PC key added. You can refresh this dashboard to review your registered credentials.' : 'This request ended. Verify an existing credential to prepare another.');
  });
  nativeState.observe(status, { attributes: true, attributeFilter: ['data-native-state'] });
  window.addEventListener('pagehide', () => { end('', true); nativeState.disconnect(); }, { once: true });
  controls();
})();
</script>`;
}
