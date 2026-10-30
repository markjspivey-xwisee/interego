/* global chrome */
(() => {
  if (window !== window.top || location.protocol !== 'https:' || location.pathname !== '/dashboard') return;
  const CODE = /^interego-link:v1:[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/;
  const used = new Set(); const bound = new WeakSet();
  let port; let activeCode; let lastButton; let lastCode; let terminal = false;
  const onDashboard = () => window === window.top && location.protocol === 'https:' && location.pathname === '/dashboard';
  const fresh = button => {
    const expires = Date.parse(button.dataset.expiresAt);
    return CODE.test(button.dataset.handoffCode) && Number.isFinite(expires) && expires > Date.now() && expires <= Date.now() + 125_000;
  };
  function ready() {
    if (!onDashboard()) { port?.disconnect(); return; }
    const button = document.getElementById('interego-local-identity-link');
    const status = document.getElementById('interego-local-identity-link-status');
    if (!button || !status) return;
    const code = button.dataset.handoffCode;
    if (port && activeCode !== code) { terminal = true; port.disconnect(); port = undefined; }
    if (!fresh(button) || used.has(code)) { button.disabled = true; return; }
    if (port) { button.disabled = true; return; }
    if (lastButton !== button || lastCode !== code) {
      lastButton = button; lastCode = code; button.disabled = false;
      status.dataset.nativeState = 'ready';
      status.textContent = 'Continue in Interego on this computer. You will review the existing account and compare a code before adding its sign-in key.';
    }
    if (bound.has(button)) return;
    bound.add(button);
    button.addEventListener('click', event => {
      if (!event.isTrusted || port || !onDashboard() || !fresh(button) || used.has(button.dataset.handoffCode)) return;
      event.preventDefault(); button.disabled = true; activeCode = button.dataset.handoffCode; used.add(activeCode); terminal = false;
      port = chrome.runtime.connect({ name: 'interego-local-identity' }); const current = port;
      current.onMessage.addListener(reply => {
        if (!onDashboard() || current !== port) { current.disconnect(); return; }
        status.dataset.nativeState = reply.state;
        if (reply.state === 'waiting') status.textContent = 'Open Interego on this computer. Check the existing account and compare code ' + reply.verificationCode + ' before approving this sign-in key.';
        else if (reply.state === 'linked') {
          terminal = true;
          status.textContent = 'This computer’s sign-in key is now linked to ' + reply.owner.displayName + ' (' + reply.owner.did + '). Hosted data stays with its current provider.';
          const refresh = document.createElement('button'); refresh.type = 'button'; refresh.textContent = 'Refresh this dashboard';
          refresh.addEventListener('click', click => { if (click.isTrusted && onDashboard()) location.reload(); }); status.append(refresh);
          current.disconnect();
        } else { terminal = true; status.textContent = reply.message || 'This link request ended. Authenticate again to prepare a fresh request.'; current.disconnect(); }
      });
      current.onDisconnect.addListener(() => {
        if (current !== port) return;
        port = undefined;
        if (!terminal) { status.dataset.nativeState = 'failed'; status.textContent = 'The link request closed. Authenticate again to prepare a fresh request.'; }
      });
      current.postMessage({ type: 'start', handoffCode: activeCode });
    });
  }
  const observer = new MutationObserver(ready);
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-handoff-code', 'data-expires-at'] });
  window.addEventListener('pagehide', () => { observer.disconnect(); port?.disconnect(); }, { once: true });
  ready();
})();
