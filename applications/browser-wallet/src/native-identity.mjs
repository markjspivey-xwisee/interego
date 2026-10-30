/* Local sign-in is a narrow, origin-bound native channel; no keys or identity bearers enter the extension. */
export const NATIVE_HOST = 'com.interego.identity';
const KEY = 'nativeIdentityRelays';
const SCRIPT = 'interego-native-identity';
const CODE = /^interego-login:v1:[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function relayOrigin(value) {
  const u = new URL(value);
  if (u.protocol !== 'https:' || u.origin !== value || u.port || u.username || u.password || !u.hostname.includes('.') || u.hostname.startsWith('[')) throw new Error('Enter the relay’s HTTPS address without a path.');
  return u.origin;
}
export function authorizeSender(sender, runtime, origins) {
  if (sender?.id !== runtime.id || sender.frameId !== 0 || !Number.isInteger(sender.tab?.id)) throw new Error('Open a relay sign-in page in the main browser tab.');
  const u = new URL(sender.url);
  if (u.pathname !== '/authorize' || u.hash || !origins.includes(relayOrigin(u.origin))) throw new Error('Local sign-in is not enabled for this relay.');
  for (const key of ['redirect_uri', 'state', 'client_id', 'code_challenge']) if (u.searchParams.getAll(key).length !== 1 || !u.searchParams.get(key)) throw new Error('Restart sign-in from your app.');
  if (!TOKEN.test(u.searchParams.get('code_challenge'))) throw new Error('Restart sign-in from your app.');
  const callback = new URL(u.searchParams.get('redirect_uri'));
  if (callback.protocol !== 'https:' || callback.username || callback.password || callback.hash || ['code', 'state', 'iss', 'error', 'error_description'].some(k => callback.searchParams.has(k))) throw new Error('This app’s callback is not supported for local sign-in.');
  return u;
}
export function validatedRedirect(value, authorization) {
  if (typeof value !== 'string' || value.length > 8192) throw new Error('The sign-in response could not be verified.');
  const target = new URL(value); const callback = new URL(authorization.searchParams.get('redirect_uri'));
  if (target.protocol !== 'https:' || target.origin !== callback.origin || target.pathname !== callback.pathname || target.username || target.password || target.hash
    || target.searchParams.getAll('code').length !== 1 || !target.searchParams.get('code') || target.searchParams.getAll('state').length !== 1
    || target.searchParams.get('state') !== authorization.searchParams.get('state') || target.searchParams.getAll('iss').length > 1
    || (target.searchParams.has('iss') && target.searchParams.get('iss') !== authorization.origin)) throw new Error('The sign-in response could not be verified.');
  const remaining = new URLSearchParams(target.search); for (const k of ['code', 'state', 'iss']) remaining.delete(k);
  if (remaining.toString() !== callback.searchParams.toString()) throw new Error('The sign-in callback changed. Start again.');
  return target.href;
}
export function createNativeIdentity({ chrome, randomUUID = () => crypto.randomUUID(), delay = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const active = new Set();
  const trustedApp = sender => sender?.id === chrome.runtime.id && sender.url === chrome.runtime.getURL('app.html');
  async function origins() { const stored = (await chrome.storage.local.get(KEY))[KEY]; return Array.isArray(stored) ? stored.filter(v => { try { return relayOrigin(v) === v; } catch { return false; } }) : []; }
  async function allowed(sender) { const u = authorizeSender(sender, chrome.runtime, await origins()); if (!await chrome.permissions.contains({ origins: [u.origin + '/*'] })) throw new Error('Enable this relay in Interego Wallet again.'); return u; }
  async function dispatch(message, sender) {
    if (!trustedApp(sender)) throw new Error('Open Interego Wallet to change local sign-in.');
    if (message.type === 'NATIVE_STATE') return { relays: await origins() };
    if (message.type !== 'NATIVE_CONFIGURE' || !Array.isArray(message.relays) || message.relays.length > 4) throw new Error('Choose up to four trusted sign-in relays.');
    const next = [...new Set(message.relays.map(relayOrigin))];
    for (const origin of next) if (!await chrome.permissions.contains({ origins: [origin + '/*'] })) throw new Error('Allow access to this relay first.');
    for (const cancel of active) cancel();
    await chrome.storage.local.set({ [KEY]: [] });
    const registered = await chrome.scripting.getRegisteredContentScripts({ ids: [SCRIPT] });
    if (registered.length) await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT] });
    if (next.length) await chrome.scripting.registerContentScripts([{ id: SCRIPT, matches: next.map(o => o + '/authorize*'), js: ['src/native-identity-content.js'], runAt: 'document_idle', allFrames: false, world: 'ISOLATED', persistAcrossSessions: true }]);
    await chrome.storage.local.set({ [KEY]: next }); return { relays: next };
  }
  function handlePort(page) {
    if (page.name !== 'interego-local-identity') return;
    let native; let stopped = false; let started = false; let pending; let authorization;
    const send = value => { if (!stopped) { try { page.postMessage(value); } catch { stop(); } } };
    const stop = () => { if (stopped) return; stopped = true; pending?.reject(new Error('Local sign-in cancelled.')); native?.disconnect(); active.delete(stop); };
    const fail = error => { send({ state: 'failed', message: error.message || 'Open the Interego app and try again.' }); stop(); };
    active.add(stop); page.onDisconnect.addListener(stop);
    function rpc(operation) {
      return new Promise((resolve, reject) => {
        const id = randomUUID(); const timer = setTimeout(() => { if (pending?.id === id) { pending = undefined; reject(new Error('The installed app did not respond. Open Interego and try again.')); } }, 20_000);
        pending = { id, resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } };
        native.postMessage({ version: 1, id, ...operation });
      });
    }
    page.onMessage.addListener(message => {
      if (started || stopped) return;
      started = true;
      void (async () => {
        if (!message || Object.keys(message).length !== 2 || message.type !== 'start' || !CODE.test(message.handoffCode)) throw new Error('Restart sign-in from your app.');
        authorization = await allowed(page.sender); if (stopped) return;
        native = chrome.runtime.connectNative(NATIVE_HOST);
        native.onDisconnect.addListener(() => { if (!stopped) fail(new Error('Open Interego on this computer and enable browser sign-in. Then try again.')); });
        native.onMessage.addListener(reply => {
          if (!pending || reply?.version !== 1 || reply.id !== pending.id) { fail(new Error('The installed app response could not be verified.')); return; }
          const current = pending; pending = undefined;
          if (reply.ok === true) current.resolve(reply.value); else current.reject(new Error('The installed app refused this sign-in request.'));
        });
        const start = await rpc({ operation: 'start', relayOrigin: authorization.origin, handoffCode: message.handoffCode });
        const expires = Date.parse(start?.expiresAt);
        if (!UUID.test(start?.id) || !TOKEN.test(start?.receipt) || typeof start?.verificationCode !== 'string' || !/^[A-Z0-9 -]{4,32}$/.test(start.verificationCode)
          || !Number.isFinite(expires) || expires <= Date.now() || expires > Date.now() + 125_000) throw new Error('The installed app response could not be verified.');
        send({ state: 'waiting', verificationCode: start.verificationCode, expiresAt: start.expiresAt });
        while (!stopped && Date.now() < expires) {
          await delay(750); if (stopped) return;
          await allowed(page.sender);
          const result = await rpc({ operation: 'poll', requestId: start.id, receipt: start.receipt });
          if (result?.state === 'complete') { await allowed(page.sender); send({ state: 'complete', redirect: validatedRedirect(result.redirect, authorization) }); stop(); return; }
          if (['denied', 'expired', 'failed'].includes(result?.state)) { send({ state: result.state, message: result.state === 'denied' ? 'Sign-in was declined in Interego.' : 'Sign-in ended. Start again from your app.' }); stop(); return; }
          if (!['waiting', 'completing'].includes(result?.state)) throw new Error('The installed app response could not be verified.');
        }
        if (!stopped) { send({ state: 'expired', message: 'This sign-in request expired. Start again from your app.' }); stop(); }
      })().catch(fail);
    });
  }
  chrome.permissions.onRemoved?.addListener(() => { for (const cancel of active) cancel(); });
  return { dispatch, handlePort };
}
