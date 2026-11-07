/* Local sign-in is a narrow, origin-bound native channel; no keys or identity bearers enter the extension. */
import { relayOrigin } from './native-origin.mjs';
import { LINK_CODE, dashboardSender, identityProviderOrigin, validatedLinkedResult } from './native-linking.mjs';
export { relayOrigin };
export const NATIVE_HOST = 'com.interego.identity';
const KEY = 'nativeIdentityRelays';
const SCRIPT = 'interego-native-identity';
const LINK_KEY = 'nativeIdentityProviders';
const LINK_SCRIPT = 'interego-native-identity-link';
const CODE = /^interego-login:v1:[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const LINK_UNCONFIRMED = 'Interego could not confirm whether this PC key was added. Refresh your registered credentials on this dashboard before starting another link.';
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
  const blocked = new Set(); let configuration = Promise.resolve(); let generation = 0;
  const trustedApp = sender => sender?.id === chrome.runtime.id && sender.url === chrome.runtime.getURL('app.html');
  async function origins(key = KEY) { const stored = (await chrome.storage.local.get(key))[key]; return Array.isArray(stored) && stored.length <= 4 ? [...new Set(stored.filter(v => { try { return relayOrigin(v) === v; } catch { return false; } }))] : []; }
  async function settings() { const [relays, providers] = await Promise.all([origins(), origins(LINK_KEY)]); return { relays, providers }; }
  function invalidate() { generation++; for (const cancel of active) cancel(); }
  async function allowed(sender, linking = false) {
    const key = linking ? LINK_KEY : KEY; const began = generation;
    if (blocked.has(key)) throw new Error('Browser access is paused. Review its settings in Interego Wallet.');
    const configured = await origins(key);
    const u = linking ? dashboardSender(sender, chrome.runtime, configured) : authorizeSender(sender, chrome.runtime, configured);
    if (!await chrome.permissions.contains({ origins: [u.origin + '/*'] }) || generation !== began || blocked.has(key)) throw new Error('Enable this browser operation in Interego Wallet again.');
    return u;
  }
  async function dispatch(message, sender) {
    if (!trustedApp(sender)) throw new Error('Open Interego Wallet to change local sign-in.');
    if (message.type === 'NATIVE_STATE') return settings();
    const linking = message.type === 'NATIVE_CONFIGURE_LINKING';
    const values = linking ? message.providers : message.relays;
    if ((!linking && message.type !== 'NATIVE_CONFIGURE') || !Array.isArray(values) || values.length > 4) throw new Error('Choose up to four trusted origins for this browser operation.');
    const next = [...new Set(values.map(linking ? identityProviderOrigin : relayOrigin))];
    const key = linking ? LINK_KEY : KEY; const script = linking ? LINK_SCRIPT : SCRIPT;
    const removeScript = async () => { if ((await chrome.scripting.getRegisteredContentScripts({ ids: [script] })).length) await chrome.scripting.unregisterContentScripts({ ids: [script] }); };
    const task = configuration.then(async () => {
      invalidate(); const began = generation; blocked.add(key);
      try {
        await chrome.storage.local.set({ [key]: [] });
        for (const origin of next) if (!await chrome.permissions.contains({ origins: [origin + '/*'] })) throw new Error('Allow access to the selected origin first.');
        await removeScript();
        if (next.length) await chrome.scripting.registerContentScripts([{ id: script, matches: next.map(o => o + (linking ? '/dashboard*' : '/authorize*')), js: [linking ? 'src/native-identity-link-content.js' : 'src/native-identity-content.js'], runAt: 'document_idle', allFrames: false, world: 'ISOLATED', persistAcrossSessions: true }]);
        for (const origin of next) if (!await chrome.permissions.contains({ origins: [origin + '/*'] })) throw new Error('Browser access changed. Enable this operation again.');
        if (began !== generation) throw new Error('Browser access changed. Enable this operation again.');
        await chrome.storage.local.set({ [key]: next });
        if (began !== generation) throw new Error('Browser access changed. Enable this operation again.');
        const current = await settings();
        if (began !== generation) throw new Error('Browser access changed. Enable this operation again.');
        blocked.delete(key); return current;
      } catch (error) {
        invalidate();
        await chrome.storage.local.set({ [key]: [] }).catch(() => {}); await removeScript().catch(() => {});
        throw error;
      }
    });
    configuration = task.catch(() => {}); return task;
  }
  function handlePort(page) {
    if (page.name !== 'interego-local-identity') return;
    let native; let stopped = false; let started = false; let pending; let authorization; let linking = false;
    const send = value => { if (!stopped) { try { page.postMessage(value); } catch { stop(); } } };
    const stop = () => { if (stopped) return; stopped = true; pending?.reject(new Error('Local sign-in cancelled.')); native?.disconnect(); active.delete(cancel); };
    const cancel = () => { send({ state: 'failed', message: linking ? LINK_UNCONFIRMED + ' Review Interego Wallet settings before connecting again.' : 'Browser access changed. Start a new request after reviewing Interego Wallet settings.' }); stop(); };
    const fail = error => { send({ state: 'failed', message: linking ? LINK_UNCONFIRMED : error.message || 'Open the Interego app and try again.' }); stop(); };
    active.add(cancel); page.onDisconnect.addListener(stop);
    function rpc(operation) {
      return new Promise((resolve, reject) => {
        const id = randomUUID(); const timer = setTimeout(() => { if (pending?.id === id) { pending = undefined; reject(new Error(linking ? LINK_UNCONFIRMED : 'The installed app did not respond. Open Interego and try again.')); } }, linking ? 65_000 : 20_000);
        pending = { id, resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } };
        try { native.postMessage({ version: 1, id, ...operation }); }
        catch { const current = pending; pending = undefined; current?.reject(new Error('The installed app connection closed. Open Interego and start again.')); }
      });
    }
    page.onMessage.addListener(message => {
      if (started || stopped) return;
      started = true;
      void (async () => {
        if (!message || Object.keys(message).length !== 2 || message.type !== 'start' || typeof message.handoffCode !== 'string' || (!CODE.test(message.handoffCode) && !LINK_CODE.test(message.handoffCode))) throw new Error('Restart this request from your app or identity dashboard.');
        linking = LINK_CODE.test(message.handoffCode);
        authorization = await allowed(page.sender, linking); if (stopped) return;
        native = chrome.runtime.connectNative(NATIVE_HOST);
        native.onDisconnect.addListener(() => { if (!stopped) fail(new Error('Open Interego on this computer and enable browser sign-in. Then try again.')); });
        native.onMessage.addListener(reply => {
          if (!pending || reply?.version !== 1 || reply.id !== pending.id) { fail(new Error('The installed app response could not be verified.')); return; }
          const current = pending; pending = undefined;
          if (reply.ok === true) current.resolve(reply.value); else current.reject(new Error(linking ? 'The installed app could not prepare this account link. Open or update Interego, then authenticate again on your dashboard.' : 'The installed app refused this sign-in request.'));
        });
        const start = await rpc({ operation: 'start', relayOrigin: authorization.origin, handoffCode: message.handoffCode });
        const expires = Date.parse(start?.expiresAt);
        if (!start || Object.keys(start).sort().join(',') !== 'expiresAt,id,receipt,verificationCode' || !UUID.test(start.id) || !TOKEN.test(start.receipt) || typeof start.verificationCode !== 'string' || !/^[A-Z0-9 -]{4,32}$/.test(start.verificationCode)
          || !Number.isFinite(expires) || expires <= Date.now() || expires > Date.now() + 125_000 || new Date(expires).toISOString() !== start.expiresAt) throw new Error('The installed app response could not be verified.');
        send({ state: 'waiting', verificationCode: start.verificationCode, expiresAt: start.expiresAt });
        while (!stopped && Date.now() < expires) {
          await delay(750); if (stopped) return;
          await allowed(page.sender, linking);
          const result = await rpc({ operation: 'poll', requestId: start.id, receipt: start.receipt });
          if (!linking && result?.state === 'complete') { await allowed(page.sender); send({ state: 'complete', redirect: validatedRedirect(result.redirect, authorization) }); stop(); return; }
          if (linking && result?.state === 'linked') { await allowed(page.sender, true); send(validatedLinkedResult(result, authorization.origin)); stop(); return; }
          if (['denied', 'expired', 'failed'].includes(result?.state)) { send({ state: result.state, message: linking ? result.state === 'denied' ? 'Account linking was declined in Interego.' : LINK_UNCONFIRMED : result.state === 'denied' ? 'Sign-in was declined in Interego.' : 'Sign-in ended. Start again from your app.' }); stop(); return; }
          if (!['waiting', 'completing'].includes(result?.state)) throw new Error('The installed app response could not be verified.');
        }
        if (!stopped) { send({ state: 'expired', message: linking ? LINK_UNCONFIRMED : 'This sign-in request expired. Start again from your app.' }); stop(); }
      })().catch(fail);
    });
  }
  chrome.permissions.onRemoved?.addListener(invalidate);
  return { dispatch, handlePort };
}
