/** Original-RP returning login. The provider cookie binds both sides; no bearer reaches this page. */
export function localIdentitySignInPage(identityOrigin: string, nonce: string): string {
  const provider = new URL(identityOrigin);
  if (provider.origin !== identityOrigin || provider.protocol !== 'https:' || provider.port || provider.username || provider.password
    || !/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) throw new Error('Returning sign-in needs a configured HTTPS provider.');
  const literal = JSON.stringify(identityOrigin).replaceAll('<', '\\u003c');
  return String.raw`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Use your existing Interego passkey</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:560px;margin:8vh auto;padding:24px;color:#203334;background:#f6f7f3}button{padding:12px 18px;border:0;border-radius:9px;background:#255b4c;color:white;font:inherit}button:disabled{opacity:.5}p{overflow-wrap:anywhere}.detail{font-size:13px;color:#526662}</style></head>
<body><h1>Use your existing Interego passkey</h1><p>Use the Windows Hello or device passkey you normally use for your Interego connections. This is its original sign-in site.</p><p id="provider" class="detail"></p><button id="verify" disabled>Sign in with my existing passkey</button><p id="status" role="status">Checking your sign-in request…</p><p class="detail">This signs into an existing account. It does not create a key, create an account, add a PC key, or move your progress.</p>
<script nonce="${nonce}">
(() => {
  'use strict';
  const provider = ${literal}, abort = new AbortController();
  const button = document.getElementById('verify'), status = document.getElementById('status');
  document.getElementById('provider').textContent = 'Returning to ' + new URL(provider).host + ' after verification.';
  const code = location.hash.slice(1); history.replaceState(null, '', location.pathname);
  const cap = /^interego-login:v1:([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/, resultCap = /^interego-login-result:v1:([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/;
  let context, busy = false;
  const bytes = value => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)), c => c.charCodeAt(0));
  function encode(value) { let binary = ''; for (const byte of new Uint8Array(value)) binary += String.fromCharCode(byte); return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
  async function post(path, body) {
    const response = await fetch(provider + '/local-identity/login/' + path, { method: 'POST', credentials: 'include', redirect: 'error', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.any([abort.signal, AbortSignal.timeout(12000)]) });
    if (!response.ok || response.redirected || !(response.headers.get('content-type') || '').startsWith('application/json')) throw new Error('Sign-in unavailable');
    const reader = response.body && response.body.getReader(); if (!reader) throw new Error('Missing response'); const chunks = []; let length = 0;
    try { for (;;) { const part = await reader.read(); if (part.done) break; length += part.value.length; if (length > 65536) throw new Error('Response too large'); chunks.push(part.value); } }
    finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    const joined = new Uint8Array(length); let at = 0; for (const part of chunks) { joined.set(part, at); at += part.length; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(joined));
  }
  function failed() { context = undefined; button.disabled = true; status.textContent = 'This sign-in could not be completed. Return to your account page and use your usual Interego passkey again. No new account or key was created.'; }
  async function prepare() {
    const start = cap.exec(code); if (!start || !window.PublicKeyCredential) throw new Error('Invalid sign-in request');
    const value = await post('context', { loginCode: code }), options = value.options, expiresAt = Date.parse(value.expiresAt), completion = resultCap.exec(value.completionCode);
    if (value.version !== 1 || value.purpose !== 'returning-passkey-login' || value.identityOrigin !== provider || value.loginId !== start[1] || !completion || completion[1] !== value.loginId
      || !Number.isFinite(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 125000 || !options || options.rpId !== location.hostname
      || !/^[A-Za-z0-9_-]{43}$/.test(options.challenge) || options.userVerification !== 'required' || !Array.isArray(options.allowCredentials) || options.allowCredentials.length !== 0) throw new Error('Invalid sign-in context');
    context = value; button.disabled = false; status.textContent = 'Ready. Use your existing Windows Hello or device passkey to sign in.';
  }
  button.addEventListener('click', event => {
    if (!event.isTrusted || busy || !context || Date.parse(context.expiresAt) <= Date.now()) return;
    busy = true; button.disabled = true; const value = context; context = undefined;
    void (async () => {
      const assertion = await navigator.credentials.get({ signal: abort.signal, publicKey: { challenge: bytes(value.options.challenge), rpId: value.options.rpId,
        allowCredentials: [], userVerification: 'required', timeout: Math.min(120000, Date.parse(value.expiresAt) - Date.now()) } });
      if (!assertion || assertion.type !== 'public-key' || abort.signal.aborted) throw new Error('Cancelled');
      const response = { id: assertion.id, rawId: encode(assertion.rawId), type: assertion.type, response: {
        authenticatorData: encode(assertion.response.authenticatorData), clientDataJSON: encode(assertion.response.clientDataJSON), signature: encode(assertion.response.signature),
        userHandle: assertion.response.userHandle ? encode(assertion.response.userHandle) : null }, clientExtensionResults: assertion.getClientExtensionResults ? assertion.getClientExtensionResults() : {} };
      const result = await post('complete', { completionCode: value.completionCode, response });
      if (result.verified !== true || Object.keys(result).length !== 1) throw new Error('Unconfirmed');
      status.textContent = 'Existing account verified. Return to your account page; it will finish signing you in. You can close this window.';
    })().catch(failed);
  });
  window.addEventListener('pagehide', () => { context = undefined; abort.abort(); }, { once: true });
  void prepare().catch(failed);
})();
</script></body></html>`;
}
