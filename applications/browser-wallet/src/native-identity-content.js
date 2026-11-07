/* global chrome */
(() => {
  if (window !== window.top || location.protocol !== 'https:' || location.pathname !== '/authorize') return;
  const button = document.getElementById('interego-local-identity');
  const status = document.getElementById('interego-local-identity-status');
  if (!button || !status || Date.parse(button.dataset.expiresAt) <= Date.now()) return;
  let port;
  button.disabled = false;
  status.textContent = 'Your sign-in key stays in Interego on this computer. You will approve this request in the app.';
  button.addEventListener('click', event => {
    if (!event.isTrusted || port) return;
    button.disabled = true;
    port = chrome.runtime.connect({ name: 'interego-local-identity' });
    port.onMessage.addListener(reply => {
      if (reply.state === 'waiting') status.textContent = 'Open Interego on this computer. Check the app and permissions, then approve code ' + reply.verificationCode + '.';
      else if (reply.state === 'complete' && typeof reply.redirect === 'string') location.assign(reply.redirect);
      else status.textContent = reply.message || 'Start sign-in again from your app.';
    });
    port.onDisconnect.addListener(() => { status.textContent += ' If sign-in has not finished, start again from your app.'; });
    port.postMessage({ type: 'start', handoffCode: button.dataset.handoffCode });
  });
  window.addEventListener('pagehide', () => port?.disconnect(), { once: true });
})();
