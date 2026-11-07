/** Provider-owned returning login. Only this origin receives its normal signed-in session. */
export function returningPasskeyLoginDashboard(identityOrigin: string, relayOrigin?: string): string {
  const provider = JSON.stringify(identityOrigin).replaceAll('<', '\\u003c');
  const relay = JSON.stringify(relayOrigin ?? null).replaceAll('<', '\\u003c');
  return String.raw`
  let cancelReturningPasskeyLogin = () => {};
  function installReturningPasskeyLogin(container) {
    cancelReturningPasskeyLogin();
    const provider = ${provider}, relay = ${relay}; if (!relay) return;
    const box = document.createElement('div'), button = document.createElement('button'), hint = document.createElement('p'), status = document.createElement('p'), cancel = document.createElement('button');
    button.id = 'returning-passkey-login'; button.type = 'button'; button.className = 'copy'; button.style.cssText = 'width:100%;padding:13px;margin-bottom:8px;background:#6366f1';
    button.textContent = 'Use my usual Interego passkey';
    hint.className = 'hint'; hint.textContent = 'The Windows Hello or device passkey you use for Interego connections. Opens ' + new URL(relay).host + ' to verify your existing account. No new account or key is created.';
    status.id = 'returning-passkey-login-status'; status.className = 'hint'; status.setAttribute('role', 'status');
    cancel.type = 'button'; cancel.className = 'copy'; cancel.textContent = 'Cancel sign-in'; cancel.hidden = true;
    box.append(button, hint, status, cancel); box.style.marginBottom = '20px';
    const accountSiteOption = container.querySelector('#signInPasskeyBtn');
    if (accountSiteOption) container.insertBefore(box, accountSiteOption); else container.append(box);
    let active;
    function end(text, notify = true) {
      const old = active; active = undefined;
      if (old) { old.abort.abort(); old.popup.close(); if (notify && old.receipt) void post('cancel', { receipt: old.receipt }).catch(() => {}); }
      button.disabled = false; cancel.hidden = true; if (text) status.textContent = text;
    }
    cancelReturningPasskeyLogin = () => end('');
    async function post(path, body, signal) {
      if (location.origin !== provider) throw new Error('Open the identity provider’s own account page to sign in.');
      const response = await fetch(provider + '/local-identity/login/' + path, { method: 'POST', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error',
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });
      if (!response.ok || response.redirected || !(response.headers.get('content-type') || '').startsWith('application/json')) throw new Error('Sign-in could not be confirmed. Use your existing passkey again.');
      const text = await response.text(); if (text.length > 65536) throw new Error('Invalid sign-in response.');
      return JSON.parse(text);
    }
    function current(flow) {
      if (active !== flow || flow.abort.signal.aborted || getToken() !== flow.previousToken || !box.isConnected) throw new Error('This account page changed. Start sign-in again.');
    }
    function pause(flow) {
      const delay = flow.delay || 750; flow.delay = Math.min(delay * 2, 5000);
      return new Promise((resolve, reject) => {
        const stop = () => { clearTimeout(timer); reject(new Error('Sign-in cancelled.')); };
        const timer = setTimeout(() => { flow.abort.signal.removeEventListener('abort', stop); resolve(); }, delay);
        flow.abort.signal.addEventListener('abort', stop, { once: true }); if (flow.abort.signal.aborted) stop();
      });
    }
    button.addEventListener('click', event => {
      if (!event.isTrusted || active) return;
      // Preopen while the trusted click is active; using the noopener feature can
      // return null even after a window opens. Detach its opener explicitly instead.
      const popup = window.open('about:blank', '_blank', 'popup,width=560,height=720');
      if (!popup) { status.textContent = 'Allow the sign-in popup, then use your usual Interego passkey again.'; return; }
      popup.opener = null;
      const flow = { popup, abort: new AbortController(), previousToken: getToken() }; active = flow; button.disabled = true; cancel.hidden = false;
      status.textContent = 'Preparing your existing-account sign-in…';
      void (async () => {
        const result = await post('start', {}, flow.abort.signal); current(flow);
        const url = new URL(result.authorizationUrl), expiresAt = Date.parse(result.expiresAt);
        if (result.version !== 1 || result.identityOrigin !== provider || url.origin !== relay || url.pathname !== '/local-identity/sign-in' || url.search || url.username || url.password
          || !/^#interego-login:v1:[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/.test(url.hash)
          || !/^interego-login-receipt:v1:[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/.test(result.receipt)
          || result.receipt.split(':').pop().split('.')[0] !== url.hash.split(':').pop().split('.')[0]
          || !Number.isFinite(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 125000) throw new Error('The existing-account request could not be verified.');
        flow.receipt = result.receipt; popup.location.replace(url.href);
        status.textContent = 'Use your usual Windows Hello or device passkey in the sign-in window. Then return here. Your account and progress stay with their existing owner.';
        for (;;) {
          await pause(flow); current(flow); if (Date.now() >= expiresAt) throw new Error('Sign-in expired. Start again with your existing passkey.');
          const answer = await post('result', { receipt: flow.receipt }, flow.abort.signal); current(flow);
          if (answer.state === 'waiting') continue;
          if (answer.state !== 'signed-in' || typeof answer.token !== 'string' || !answer.token || answer.token.length > 16384 || /\s/.test(answer.token)
            || typeof answer.userId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(answer.userId)) throw new Error('The existing-account sign-in was not confirmed.');
          sessionStorage.setItem('cg.token', answer.token); end('Signed into your existing account.', false);
          await renderDashboard(); return;
        }
      })().catch(error => { if (active === flow) end(error.message || 'Sign-in ended. Use your existing passkey again.'); });
    });
    cancel.addEventListener('click', () => end('Sign-in cancelled. No new account or key was created.'));
    window.addEventListener('pagehide', () => end(''), { once: true });
  }
`;
}
