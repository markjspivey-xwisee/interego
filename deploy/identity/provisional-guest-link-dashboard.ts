/**
 * The dashboard's section for linking a general guest to the signed-in account
 * (provisional-guest-link-routes.ts). Included in the dashboard only while the general guest door is
 * on, so a deployment without it serves the dashboard it always did.
 *
 * The bearer and the credential proof stay on identity's origin: the section asks for a link code,
 * shows it with the door's address, and lists and unlinks the account's guests. Each code and each
 * unlink is preceded by a fresh proof by a passkey registered on this site or a wallet already on
 * the account. It uses the dashboard's own `getToken` and `IDENTITY_BASE`.
 */
export function guestLinkDashboard(doorUrl: string): string {
  return String.raw`
<section id="guest-link-settings" class="card full" style="margin-top:18px" aria-labelledby="guest-link-title">
  <h2 id="guest-link-title">Link a guest to this account</h2>
  <p>If you used an application as a guest, in this browser or on another device, you can link that guest to this account. Applications that offer guest access then treat that guest as this account.</p>
  <button id="guest-link-load" class="copy" type="button" style="margin-top:14px">Choose a passkey or wallet already on this account</button>
  <div id="guest-link-methods" hidden style="margin-top:14px">
    <label for="guest-link-method">Confirm with</label>
    <select id="guest-link-method" style="display:block;width:100%;margin:8px 0 12px;padding:9px;background:#0a0a0f;color:#e0e0e8;border:1px solid #3a3a4a;border-radius:6px"></select>
    <button id="guest-link-code" class="copy" type="button">Get a link code</button>
  </div>
  <div id="guest-link-result" hidden style="margin-top:14px">
    <p>Link code, valid until <span id="guest-link-expires"></span>:</p>
    <pre id="guest-link-value" style="white-space:pre-wrap;overflow-wrap:anywhere;font-size:1.1rem;margin:8px 0"></pre>
    <p class="hint">In the browser that holds the guest, open <a id="guest-link-door" rel="noopener noreferrer" target="_blank"></a> and enter this code. That page shows this account's name before it links anything.</p>
    <p class="hint">Whoever enters this code links <em>their</em> guest to your account, and that guest then acts as you in applications. Enter it yourself; give it to nobody. It works once.</p>
  </div>
  <div id="guest-link-list" style="margin-top:14px"></div>
  <p id="guest-link-status" class="hint" role="status" style="margin-top:12px"></p>
</section>
<script>
(() => {
  'use strict';
  const DOOR = ${JSON.stringify(doorUrl).replace(/</g, '\\u003c')};
  const el = id => document.getElementById(id);
  const load = el('guest-link-load'), methods = el('guest-link-methods'), select = el('guest-link-method'), get = el('guest-link-code');
  const result = el('guest-link-result'), list = el('guest-link-list'), status = el('guest-link-status');
  let busy = false;
  const say = (text, error = false) => { status.textContent = text; status.className = error ? 'err' : 'hint'; status.setAttribute('role', error ? 'alert' : 'status'); };
  const from64 = text => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), character => character.charCodeAt(0));
  const to64 = buffer => btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  async function api(path, body) {
    const bearer = typeof getToken === 'function' ? getToken() : null;
    if (!bearer) throw new Error('Sign in to this account above, then try again.');
    const base = new URL(IDENTITY_BASE).origin;
    if (base !== location.origin) throw new Error('Open these account settings on the identity provider’s own address.');
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error',
      headers: { Accept: 'application/json', Authorization: 'Bearer ' + bearer, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const answer = await response.json().catch(() => ({}));
    if (!response.ok || !answer || typeof answer !== 'object') throw new Error((answer && (answer.message || answer.error)) || 'The request was refused.');
    return answer;
  }
  // A fresh proof by a credential already on this account, for exactly this action.
  async function prove(action) {
    const choice = select.value;
    if (!(typeof getToken === 'function' && getToken()) || !choice) throw new Error('Sign in to this account above and choose a passkey or wallet, then try again.');
    if (choice === 'passkey') {
      const prepared = await api('/guest/link/prepare', { ...action, method: 'passkey' });
      const options = prepared.options;
      if (!navigator.credentials?.get || !options || !Array.isArray(options.allowCredentials)) throw new Error('This browser cannot confirm a passkey here.');
      const assertion = await navigator.credentials.get({ publicKey: { challenge: from64(options.challenge), rpId: options.rpId,
        allowCredentials: options.allowCredentials.map(item => ({ type: 'public-key', id: from64(item.id), ...(Array.isArray(item.transports) ? { transports: item.transports } : {}) })),
        userVerification: 'required', timeout: 120000 } });
      if (!assertion || assertion.type !== 'public-key') throw new Error('No passkey was confirmed.');
      return { stepUpId: prepared.stepUpId, response: { id: assertion.id, rawId: to64(assertion.rawId), type: assertion.type, response: {
        authenticatorData: to64(assertion.response.authenticatorData), clientDataJSON: to64(assertion.response.clientDataJSON), signature: to64(assertion.response.signature),
        userHandle: assertion.response.userHandle ? to64(assertion.response.userHandle) : null },
        clientExtensionResults: assertion.getClientExtensionResults ? assertion.getClientExtensionResults() : {} } };
    }
    if (!window.ethereum?.request) throw new Error('Open the wallet already on this account, then try again.');
    const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
    if (!Array.isArray(accounts) || !accounts.some(address => typeof address === 'string' && address.toLowerCase() === choice.toLowerCase())) throw new Error('Switch your wallet to ' + choice + ', then try again.');
    const chain = await window.ethereum.request({ method: 'eth_chainId' });
    if (typeof chain !== 'string' || !/^0x[0-9a-fA-F]{1,13}$/.test(chain)) throw new Error('The wallet network could not be checked.');
    const prepared = await api('/guest/link/prepare', { ...action, method: 'wallet', address: choice, chainId: parseInt(chain, 16) });
    if (typeof prepared.message !== 'string' || typeof prepared.address !== 'string' || prepared.address.toLowerCase() !== choice.toLowerCase()) throw new Error('The wallet message could not be checked.');
    const hex = '0x' + Array.from(new TextEncoder().encode(prepared.message), byte => byte.toString(16).padStart(2, '0')).join('');
    const signature = await window.ethereum.request({ method: 'personal_sign', params: [hex, prepared.address] });
    if (typeof signature !== 'string') throw new Error('The wallet did not sign.');
    return { stepUpId: prepared.stepUpId, signature };
  }
  async function guests() {
    const answer = await api('/guest/link/guests');
    list.replaceChildren();
    for (const guest of Array.isArray(answer.guests) ? answer.guests : []) {
      const row = document.createElement('p'); const button = document.createElement('button');
      row.textContent = 'Linked guest ' + String(guest.userId).slice(-8) + ', until ' + new Date(guest.standingUntil * 1000).toLocaleString() + ' ';
      button.type = 'button'; button.className = 'copy'; button.textContent = 'Unlink';
      button.addEventListener('click', () => run(async () => {
        await api('/guest/link/unlink', await prove({ action: 'unlink', guest: guest.userId }));
        await guests(); say('That guest is no longer linked to this account.');
      }));
      row.append(button); list.append(row);
    }
  }
  async function run(work) {
    if (busy) return; busy = true; load.disabled = get.disabled = true;
    try { await work(); } catch (error) { say(error && error.message ? error.message : 'Not done.', true); }
    finally { busy = false; load.disabled = get.disabled = false; }
  }
  load.addEventListener('click', () => run(async () => {
    const bearer = typeof getToken === 'function' ? getToken() : null;
    if (!bearer) throw new Error('Sign in to this account above, then try again.');
    const response = await fetch(new URL(IDENTITY_BASE).origin + '/local-identity/link/methods', { credentials: 'omit', cache: 'no-store', redirect: 'error', headers: { Accept: 'application/json', Authorization: 'Bearer ' + bearer } });
    const available = response.ok ? await response.json() : null;
    if (!available) throw new Error('This account’s sign-in methods could not be read. Sign in again.');
    select.replaceChildren();
    const add = (value, label) => { const option = document.createElement('option'); option.value = value; option.textContent = label; select.append(option); };
    if (Array.isArray(available.passkeyOrigins) && available.passkeyOrigins.includes(location.origin)) add('passkey', 'A passkey registered on this site');
    for (const address of Array.isArray(available.walletAddresses) ? available.walletAddresses : []) if (typeof address === 'string') add(address, 'Wallet ' + address);
    if (!select.options.length) throw new Error('This account has no passkey registered on this site and no wallet. Add one before linking a guest.');
    methods.hidden = false; say('');
    await guests();
  }));
  get.addEventListener('click', () => run(async () => {
    result.hidden = true;
    const issued = await api('/guest/link/code', await prove({ action: 'code' }));
    if (typeof issued.code !== 'string' || typeof issued.expiresAt !== 'string') throw new Error('No code was issued.');
    el('guest-link-value').textContent = issued.code;
    el('guest-link-expires').textContent = new Date(issued.expiresAt).toLocaleTimeString();
    const door = el('guest-link-door'); door.textContent = DOOR; door.href = DOOR;
    result.hidden = false; say('Enter the code in the browser that holds the guest within five minutes.');
  }));
})();
</script>`;
}
