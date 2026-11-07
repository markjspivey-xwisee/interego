import type { DesktopApi, PodStatus } from './types.js';
import type { FederationStatus } from '@interego/pod-federation';

interface Context { pod(): PodStatus | null; locallyBusy(): boolean }
const date = (value: string) => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : 'Unavailable';

/** Native owner controls. Remote names and snapshots are always rendered as text. */
export function installFederationUi(api: DesktopApi, context: Context): { refresh(): Promise<void>; updateAvailability(): void } {
  const el = <T extends HTMLElement = HTMLElement>(id: string): T => {
    const found = document.getElementById(id); if (!found) throw new Error(`Missing sharing element: ${id}`); return found as T;
  };
  const button = (id: string) => el<HTMLButtonElement>(id);
  const input = (id: string) => el<HTMLInputElement>(id);
  let state: FederationStatus | undefined;
  let changing = false; let epoch = 0; let read = 0;
  let invite: string | undefined;
  let confirmDisconnect: string | undefined;
  let extensionsLoaded = false;
  let confirmReset = false;
  const acknowledged = new Set<string>();
  let confirmRemove: string | undefined;

  function message(value: string, error = false): void {
    const target = el('federation-message'); target.textContent = value; target.hidden = !value;
    target.classList.toggle('error', error); target.setAttribute('role', error ? 'alert' : 'status');
  }
  function controls(): void {
    const occupied = changing || context.locallyBusy();
    const available = !!context.pod()?.running && !context.pod()?.restorePending;
    for (const control of Array.from(el('federation-panel').querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>('button,input,select,textarea'))) control.disabled = occupied;
    button('enable-federation').disabled = occupied || !available || !state || !input('federation-consent').checked;
    button('disable-federation').disabled = occupied || state?.enabled === false;
    for (const id of ['create-federation-invite', 'accept-federation-invite', 'send-federation-notes']) button(id).disabled = occupied || !available || !state?.enabled;
    button('copy-federation-invite').disabled = occupied || !invite;
    button('load-federation-notes').disabled = occupied || !available || !state?.enabled;
    for (const control of Array.from(el('federation-pending').querySelectorAll<HTMLButtonElement>('button[data-approve]'))) {
      const checkbox = el<HTMLInputElement>(control.dataset['approve']!);
      control.disabled = occupied || !state?.enabled || !checkbox.checked;
    }
    button('save-browser-extensions').disabled = occupied;
  }
  function render(): void {
    el('federation-status').textContent = !state ? 'Sharing status unavailable' : state.enabled ? 'Pod sharing on' : 'Pod sharing off';
    el('federation-status').classList.toggle('inactive', !state?.enabled);
    el('federation-privacy-label').textContent = !state ? 'Sharing status unknown' : state.enabled ? 'Selected pod sharing on' : 'Federation off';
    el('settings-federation-status').textContent = !state ? 'Unknown' : state.enabled ? 'Selected sharing on' : 'Off';
    el('settings-federation-description').textContent = state?.enabled ? 'Only snapshots you select are shared with approved pods.' : 'Enable selected sharing in Connections when you choose.';
    el('federation-enable-fields').hidden = !!state?.enabled;
    el('federation-active-fields').hidden = state?.enabled === false;
    const activePeers = state?.peers.filter(peer => !peer.revokedAt) ?? [];
    el('federation-share-form').hidden = !state?.enabled || !activePeers.length;
    el('federation-peers-heading').hidden = !state?.enabled && !state?.peers.length;
    el('federation-peers').hidden = !state?.enabled && !state?.peers.length;
    el('federation-received-heading').hidden = !state?.enabled && !state?.received.length;
    el('federation-invite-field').hidden = !invite;
    button('clear-federation-history').hidden = !state?.sent.length;
    button('reset-federation').hidden = state?.configured === false;
    button('reset-federation').textContent = confirmReset ? 'Confirm reset: remove connections and received snapshots' : 'Reset pod sharing';
    el('federation-profile').textContent = state?.profile ? `${state.profile.name} · ${state.profile.endpoint}` : 'Save and enable a permanent HTTPS address in web setup above, then enable sharing here.';
    if (state?.profile && document.activeElement !== input('federation-name')) input('federation-name').value = state.profile.name;
    const pending = el('federation-pending'); pending.replaceChildren();
    for (const request of state?.pending ?? []) {
      const card = document.createElement('article'); card.className = 'connection-card';
      const heading = document.createElement('h3'); heading.textContent = `${request.peer.name} wants to connect`;
      const detail = document.createElement('p'); detail.textContent = `${request.peer.endpoint} · ${request.peer.fingerprint}`;
      const code = document.createElement('p'); code.className = 'bridge-url'; code.textContent = request.verificationCode;
      const label = document.createElement('label'); label.className = 'scope-choice';
      const signature = `${request.id}:${request.verificationCode}`;
      const check = document.createElement('input'); check.type = 'checkbox'; check.id = `federation-verify-${request.id}`; check.checked = acknowledged.has(signature);
      label.append(check, document.createTextNode('I compared this code with the person I am connecting to.'));
      const approve = document.createElement('button'); approve.textContent = 'Accept connection'; approve.className = 'primary'; approve.dataset['approve'] = check.id;
      check.addEventListener('change', () => { if (check.checked) acknowledged.add(signature); else acknowledged.delete(signature); controls(); });
      approve.addEventListener('click', () => { if (check.checked) { acknowledged.delete(signature); void change(async () => { state = await api.approveFederation(request.id, request.verificationCode); }, 'Connection accepted. Choose notes to share.'); } });
      const deny = document.createElement('button'); deny.textContent = 'Deny'; deny.className = 'secondary';
      deny.addEventListener('click', () => { void change(async () => { state = await api.denyFederation(request.id); }, 'Invitation declined.'); });
      card.append(heading, detail, code, label, approve, deny); pending.append(card);
    }
    const joining = el('federation-joining'); joining.replaceChildren();
    for (const request of state?.joining ?? []) {
      const card = document.createElement('p'); card.textContent = `Waiting for ${request.peer.name} to accept. Compare code ${request.verificationCode}; expires ${date(request.expiresAt)}. Then choose Refresh sharing.`;
      joining.append(card);
    }
    const peers = el('federation-peers'); peers.replaceChildren();
    const select = el<HTMLSelectElement>('federation-peer'); const selected = select.value; select.replaceChildren();
    for (const peer of state?.peers ?? []) {
      const card = document.createElement('article'); card.className = 'connection-card';
      const heading = document.createElement('h3'); heading.textContent = peer.name;
      const detail = document.createElement('p'); detail.textContent = `${peer.kind === 'hosted' ? 'Hosted pod' : 'Local pod'} · ${peer.endpoint}`;
      const fingerprint = document.createElement('p'); fingerprint.className = 'small'; fingerprint.textContent = peer.fingerprint;
      card.append(heading, detail, fingerprint);
      if (peer.revokedAt) { const label = document.createElement('p'); label.textContent = 'Disconnected. Previously received copies may remain.'; card.append(label); }
      else {
        const option = document.createElement('option'); option.value = peer.id; option.textContent = peer.name; select.append(option);
        const revoke = document.createElement('button'); revoke.className = 'danger';
        revoke.textContent = confirmDisconnect === peer.id ? 'Confirm disconnect' : 'Disconnect pod';
        revoke.addEventListener('click', () => {
          if (confirmDisconnect !== peer.id) { confirmDisconnect = peer.id; render(); return; }
          confirmDisconnect = undefined;
          void change(async () => { state = await api.revokeFederation(peer.id); }, 'Pod disconnected. New transfers are blocked; existing copies may remain.');
        }); card.append(revoke);
      }
      peers.append(card);
    }
    if (Array.from(select.options).some(option => option.value === selected)) select.value = selected;
    if (!state?.peers.length) { const empty = document.createElement('p'); empty.textContent = 'No pods connected. Create an invitation or paste one from your brother.'; peers.append(empty); }
    const received = el('federation-received'); received.replaceChildren();
    for (const item of state?.received ?? []) {
      const sender = state?.peers.find(peer => peer.id === item.from)?.name ?? 'Connected pod';
      const readButton = document.createElement('button'); readButton.className = 'note-item';
      readButton.textContent = `Read snapshot from ${sender} · ${date(item.receivedAt)}`;
      readButton.addEventListener('click', () => { void change(async () => {
        const resource = await api.readFederation(item.id);
        el('federation-read-title').textContent = resource.note?.title ?? 'Shared resource';
        el('federation-read-source').textContent = `From ${sender} · ${resource.iri} · ${resource.mediaType}`;
        el('federation-read-body').textContent = resource.note?.body ?? resource.content;
        el('federation-reader').hidden = false;
      }); });
      const card = document.createElement('article'); card.append(readButton);
      const remove = document.createElement('button'); remove.className = 'quiet';
      remove.textContent = confirmRemove === item.id ? 'Confirm remove local copy' : 'Remove local copy';
      remove.addEventListener('click', () => {
        if (confirmRemove !== item.id) { confirmRemove = item.id; render(); return; }
        confirmRemove = undefined;
        void change(async () => { state = await api.removeFederationSnapshot(item.id); el('federation-reader').hidden = true; el('federation-read-body').textContent = ''; }, 'Received copy removed from this computer. Other pods are unchanged.');
      }); card.append(remove); received.append(card);
    }
    el('federation-received-empty').hidden = !state?.enabled || !!state.received.length;
    controls();
  }
  async function change(action: () => Promise<void>, success = ''): Promise<void> {
    if (changing || context.locallyBusy()) return;
    changing = true; epoch++; read++; message(''); controls();
    try { await action(); if (success) message(success); }
    catch (error) { message(error instanceof Error && error.message.length <= 350 ? error.message : 'This change could not be confirmed. Refresh sharing before trying again.', true); }
    finally { changing = false; render(); }
  }
  async function refresh(): Promise<void> {
    if (changing) return;
    const requested = ++read; const began = epoch;
    try {
      const value = await api.federationStatus();
      if (requested !== read || began !== epoch) return;
      state = value;
      if (!extensionsLoaded) {
        const ids = await api.browserExtensionIds();
        if (requested !== read || began !== epoch) return;
        el<HTMLTextAreaElement>('browser-extension-ids').value = ids.join('\n'); extensionsLoaded = true;
      }
    } catch { if (requested === read && began === epoch) { state = undefined; message('Sharing or browser settings could not be checked. Refresh to try again.', true); } }
    if (requested === read && began === epoch) render();
  }
  el<HTMLFormElement>('federation-enable-form').addEventListener('submit', event => {
    event.preventDefault(); if (!input('federation-consent').checked) return;
    const name = input('federation-name').value.trim();
    void change(async () => { state = await api.enableFederation(name); input('federation-consent').checked = false; }, 'Sharing enabled. Invite someone, then choose exactly what to send.');
  });
  input('federation-consent').addEventListener('change', controls);
  button('disable-federation').addEventListener('click', () => { void change(async () => { state = await api.disableFederation(); invite = undefined; el<HTMLTextAreaElement>('federation-invite-code').value = ''; }, 'Pod sharing paused. Local copies remain available.'); });
  button('refresh-federation').addEventListener('click', () => { void change(async () => { state = state?.enabled ? await api.refreshFederation() : await api.federationStatus(); }, 'Sharing refreshed.'); });
  button('create-federation-invite').addEventListener('click', () => { void change(async () => {
    const created = await api.createFederationInvite(); invite = created.code;
    el<HTMLTextAreaElement>('federation-invite-code').value = created.code;
    el('federation-invite-expiry').textContent = `One use; expires ${date(created.expiresAt)}. Send privately to the person you want to connect with.`;
    state = await api.federationStatus();
  }); });
  button('copy-federation-invite').addEventListener('click', () => { if (invite) void change(() => api.copyFederationInvite(invite!), 'Invitation copied. Send it privately to your brother.'); });
  el<HTMLFormElement>('federation-accept-form').addEventListener('submit', event => {
    event.preventDefault(); const code = el<HTMLTextAreaElement>('federation-incoming-code').value.trim();
    void change(async () => { state = await api.acceptFederationInvite(code); el<HTMLTextAreaElement>('federation-incoming-code').value = ''; }, 'Compare the code with the sender. They must accept before sharing starts.');
  });
  button('load-federation-notes').addEventListener('click', () => { void change(async () => {
    const notes = await api.notes(); const list = el('federation-note-choices'); list.replaceChildren();
    for (const note of notes) {
      const label = document.createElement('label'); label.className = 'scope-choice';
      const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.value = note.id; checkbox.name = 'share-note';
      label.append(checkbox, document.createTextNode(note.title)); list.append(label);
    }
    if (!notes.length) list.textContent = 'Save a note in Memory before sharing.';
  }); });
  el<HTMLFormElement>('federation-share-form').addEventListener('submit', event => {
    event.preventDefault(); const peerId = el<HTMLSelectElement>('federation-peer').value;
    const chosen = Array.from(el('federation-note-choices').querySelectorAll<HTMLInputElement>('input:checked'));
    const noteIds = chosen.map(value => value.value);
    if (!peerId || !noteIds.length || noteIds.length > 10 || !input('federation-share-consent').checked) { message('Choose a connected pod, one to ten notes, and confirm sending these snapshots.', true); return; }
    // Consume the reviewed selection before dispatch; uncertain sends are never replayed.
    for (const checkbox of chosen) checkbox.checked = false; input('federation-share-consent').checked = false;
    void change(async () => { state = await api.shareFederation({ peerId, noteIds }); }, 'Selected snapshots delivered. Other notes stay private.');
  });
  button('close-federation-reader').addEventListener('click', () => { el('federation-reader').hidden = true; el('federation-read-body').textContent = ''; });
  button('reset-federation').addEventListener('click', () => {
    if (!confirmReset) { confirmReset = true; message('Reset removes saved pod connections, invitations and received snapshots. Your own notes and web assistant connections remain.'); render(); return; }
    confirmReset = false;
    void change(async () => { state = await api.forgetFederation(); invite = undefined; el<HTMLTextAreaElement>('federation-invite-code').value = ''; el('federation-reader').hidden = true; el('federation-read-body').textContent = ''; }, 'Sharing setup reset. Your own notes remain in Memory.');
  });
  button('clear-federation-history').addEventListener('click', () => { void change(async () => { state = await api.clearFederationHistory(); }, 'Sent history cleared. Connections and delivered copies remain.'); });
  el<HTMLFormElement>('browser-extension-form').addEventListener('submit', event => {
    event.preventDefault(); const ids = el<HTMLTextAreaElement>('browser-extension-ids').value.split(/[\s,]+/).filter(Boolean);
    void change(async () => { const saved = await api.setBrowserExtensionIds(ids); el<HTMLTextAreaElement>('browser-extension-ids').value = saved.join('\n'); extensionsLoaded = true; }, 'Browser origin settings saved. Each extension must still complete its own notes approval.');
  });
  render(); return { refresh, updateAvailability: controls };
}
