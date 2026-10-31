/** Fresh verification at a passkey's original RP; carries no owner bearer or native key. */
export function localIdentityLinkStepUpPage(identityOrigin: string, nonce: string): string {
  const provider = new URL(identityOrigin);
  if (provider.origin !== identityOrigin || provider.protocol !== 'https:' || provider.username || provider.password || provider.port
    || !/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) throw new Error('Account linking needs a configured HTTPS identity provider.');
  const literal = JSON.stringify(identityOrigin).replaceAll('<', '\\u003c');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Verify your existing account</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:560px;margin:8vh auto;padding:24px;color:#203334;background:#f6f7f3}button{padding:12px 18px;border:0;border-radius:9px;background:#255b4c;color:white;font:inherit}button:disabled{opacity:.5}p{overflow-wrap:anywhere}.detail{font-size:13px;color:#526662}</style></head>
<body><h1>Verify your existing account</h1><p>Your passkey was created on this sign-in site. Use it here to confirm adding your PC's local key to the same account.</p><p id="account" class="detail"></p><button id="verify" disabled>Verify with my existing passkey</button><p id="status" role="status">Checking this request…</p><p class="detail">This step does not create an account or move game progress. You will also approve the local key in the Interego app.</p>
<script nonce="${nonce}">
(() => {
  'use strict';
  const provider = ${literal};
  const button = document.getElementById('verify'); const status = document.getElementById('status'); const account = document.getElementById('account');
  const abort = new AbortController(); let context; let busy = false; let expiryTimer; let expired = false; let submitted = false;
  const code = location.hash.slice(1); history.replaceState(null, '', location.pathname);
  const token = /^[A-Za-z0-9_-]{43}$/;
  const cap = /^interego-link-step-up:v1:[A-Za-z0-9_-]{43}\\.[A-Za-z0-9_-]{43}$/;
  const finish = /^interego-link-step-up-result:v1:[A-Za-z0-9_-]{43}\\.[A-Za-z0-9_-]{43}$/;
  function bytes(value) {
    const raw = value.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((value.length + 3) % 4);
    return Uint8Array.from(atob(raw), c => c.charCodeAt(0));
  }
  function encode(value) {
    let binary = ''; for (const byte of new Uint8Array(value)) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
  }
  async function post(path, body) {
    const response = await fetch(provider + path, { method: 'POST', credentials: 'omit', redirect: 'error',
      headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body),
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(12000)]) });
    if (!response.ok || response.redirected || !(response.headers.get('content-type') || '').startsWith('application/json')) throw new Error('Request unavailable');
    const reader = response.body && response.body.getReader(); if (!reader) throw new Error('Missing response');
    const chunks = []; let size = 0;
    try {
      for (;;) { const item = await reader.read(); if (item.done) break; size += item.value.length; if (size > 65536) throw new Error('Response too large'); chunks.push(item.value); }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    const joined = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.length; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(joined));
  }
  function clearExpiry() { clearTimeout(expiryTimer); expiryTimer = undefined; }
  function expire() {
    if (submitted || expired) return;
    expired = true; context = undefined; button.disabled = true; clearExpiry(); abort.abort();
    status.textContent = 'This two-minute request expired. Return to your existing account dashboard and start a new link. Your progress has not been moved.';
  }
  function fail() { if (expired) return; clearExpiry(); context = undefined; button.disabled = true; status.textContent = 'This verification could not be completed. Return to your account dashboard and start a new link. Your progress has not been moved.'; }
  async function prepare() {
    if (!cap.test(code) || !window.PublicKeyCredential) throw new Error('Invalid request');
    const value = await post('/local-identity/link/step-up/context', { stepUpCode: code });
    const expiry = Date.parse(value.expiresAt); const options = value.options;
    if (value.version !== 1 || value.purpose !== 'link-step-up' || value.identityOrigin !== provider || !token.test(value.stepUpId)
      || !finish.test(value.completionCode) || !Number.isFinite(expiry) || expiry <= Date.now() || expiry > Date.now() + 125000
      || !options || !token.test(options.challenge) || options.userVerification !== 'required' || typeof options.rpId !== 'string'
      || !(location.hostname === options.rpId || location.hostname.endsWith('.' + options.rpId))
      || !Array.isArray(options.allowCredentials) || !options.allowCredentials.length || options.allowCredentials.length > 100
      || options.allowCredentials.some(c => !c || c.type !== 'public-key' || typeof c.id !== 'string' || !/^[A-Za-z0-9_-]{1,2048}$/.test(c.id))
      || !value.owner || typeof value.owner.did !== 'string' || value.owner.did.length > 512) throw new Error('Invalid context');
    if (abort.signal.aborted) return;
    context = value; expiryTimer = setTimeout(expire, Math.max(1, expiry - Date.now()));
    account.textContent = 'Existing account: ' + value.owner.did;
    status.textContent = 'Check the account above, then verify with its existing passkey.'; button.disabled = false;
  }
  button.addEventListener('click', event => {
    if (!event.isTrusted || busy || !context) return;
    if (Date.parse(context.expiresAt) <= Date.now()) { expire(); return; }
    busy = true; button.disabled = true; const value = context; context = undefined;
    void (async () => {
      const options = value.options;
      const assertion = await navigator.credentials.get({ signal: abort.signal, publicKey: { challenge: bytes(options.challenge), rpId: options.rpId,
        allowCredentials: options.allowCredentials.map(c => ({ type: 'public-key', id: bytes(c.id) })), userVerification: 'required', timeout: Math.min(120000, Date.parse(value.expiresAt) - Date.now()) } });
      if (!assertion || abort.signal.aborted) throw new Error('Cancelled');
      const response = { id: assertion.id, rawId: encode(assertion.rawId), type: assertion.type, response: {
        authenticatorData: encode(assertion.response.authenticatorData), clientDataJSON: encode(assertion.response.clientDataJSON), signature: encode(assertion.response.signature),
        userHandle: assertion.response.userHandle ? encode(assertion.response.userHandle) : null },
        clientExtensionResults: assertion.getClientExtensionResults ? assertion.getClientExtensionResults() : {} };
      // Once submitted before the deadline, the server decides the proof's outcome. A slow
      // response must not turn genuine server verification into a local expiry.
      if (Date.parse(value.expiresAt) <= Date.now()) { expire(); return; }
      submitted = true; clearExpiry();
      const result = await post('/local-identity/link/step-up/complete', { completionCode: value.completionCode, response });
      if (result.verified !== true || Object.keys(result).length !== 1) throw new Error('Unconfirmed');
      status.textContent = 'Existing account verified. Return to your account dashboard to connect the Interego app. You can close this tab.';
    })().catch(fail);
  });
  window.addEventListener('pagehide', () => { clearExpiry(); context = undefined; button.disabled = true; abort.abort(); }, { once: true });
  void prepare().catch(fail);
})();
</script></body></html>`;
}
