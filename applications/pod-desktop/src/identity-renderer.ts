import type { DesktopApi, PodStatus } from './types.js';
import type { LocalIdentityApproval, LocalIdentityStatus } from './local-identity-types.js';

interface Context {
  pod(): PodStatus | null;
  locallyBusy(): boolean;
  openDialog(dialog: HTMLDialogElement): void;
  closeDialog(dialog: HTMLDialogElement): void;
}
const METHODS = ['localIdentityStatus', 'setupLocalIdentity', 'approveLocalIdentity', 'denyLocalIdentity', 'forgetLocalIdentity', 'identityExtensionIds',
  'setIdentityExtensionIds', 'backupLocalIdentity', 'restoreLocalIdentity'] as const;
const fingerprint = (value: LocalIdentityStatus | undefined) => value?.identity?.fingerprint;
const fresh = (request: LocalIdentityApproval) => Number.isFinite(Date.parse(request.expiresAt)) && Date.parse(request.expiresAt) > Date.now();
const permissionLabel = (scope: string) => {
  const label: Record<string, string> = { 'mcp:read': 'Read hosted pod context', 'mcp:write': 'Read and change hosted pod context', mcp: 'Full hosted pod tool access', 'federation:manage': 'Manage pod sharing' };
  return label[scope] ? `${label[scope]} (${scope})` : scope;
};

/** Native owner consent. Remote labels are text, and approval belongs to one exact request snapshot. */
export function installIdentityUi(api: DesktopApi, context: Context): { refresh(): Promise<void>; updateAvailability(): void } {
  const identityApi = api;
  const supported = METHODS.every(method => typeof identityApi?.[method] === 'function');
  const el = <T extends HTMLElement = HTMLElement>(id: string): T => {
    const found = document.getElementById(id); if (!found) throw new Error(`Missing identity element: ${id}`); return found as T;
  };
  const input = (id: string) => el<HTMLInputElement>(id);
  const button = (id: string) => el<HTMLButtonElement>(id);
  const dialog = el<HTMLDialogElement>('identity-backup-dialog');
  let state: LocalIdentityStatus | undefined;
  const signature = (request: LocalIdentityApproval) => JSON.stringify([request, state?.identity?.did, fingerprint(state)]);
  let readFailure = false;
  let changing = false; let epoch = 0; let reading = 0; let extensionsLoaded = false; let extensionsDirty = false;
  let backupMode: 'backup' | 'restore' = 'backup'; let forgetFingerprint: string | undefined;
  const acknowledged = new Set<string>();
  const available = () => supported && !!context.pod()?.configured && !context.pod()?.restorePending;
  const occupied = () => changing || context.locallyBusy();
  const recovery = () => readFailure || !!state?.configured && !state.identity;
  const currentFingerprint = () => fingerprint(state) ?? (recovery() ? 'unavailable' : undefined);
  function message(value: string, error = false): void {
    const target = el('identity-message'); target.textContent = value; target.hidden = !value;
    target.classList.toggle('error', error); target.setAttribute('role', error ? 'alert' : 'status');
  }
  function dialogMessage(value: string, error = false): void {
    const target = el('identity-backup-message'); target.textContent = value; target.hidden = !value;
    target.classList.toggle('error', error); target.setAttribute('role', error ? 'alert' : 'status');
  }
  function clearPassphrases(): void { input('identity-passphrase').value = ''; input('identity-passphrase-confirmation').value = ''; }
  function controls(): void {
    const blocked = occupied() || !available();
    for (const control of Array.from(el('identity-page').querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLTextAreaElement>('input,button,textarea'))) control.disabled = blocked;
    button('open-identity-dashboard').disabled = occupied() || typeof api.openHosted !== 'function';
    button('refresh-identity').disabled = occupied() || !supported;
    button('create-local-identity').disabled = blocked || !state || state.configured || !input('identity-create-consent').checked;
    button('save-identity-extensions').disabled = blocked || !state?.configured || !extensionsLoaded || !input('identity-extension-consent').checked;
    button('backup-local-identity').disabled = blocked || (!state?.configured && !readFailure);
    button('restore-local-identity').disabled = blocked || !state || state.configured;
    button('forget-local-identity').disabled = blocked || (!state?.configured && !readFailure);
    button('confirm-forget-local-identity').disabled = blocked || !forgetFingerprint || forgetFingerprint !== currentFingerprint() || !input('identity-forget-consent').checked;
    for (const approve of Array.from(el('identity-pending').querySelectorAll<HTMLButtonElement>('button[data-identity-approve]'))) {
      const request = state?.pending.find(item => item.id === approve.dataset['identityApprove']);
      approve.disabled = blocked || !request || !state?.identity || request.state !== 'waiting' || !fresh(request)
        || request.purpose === 'link' && (request.credentialDid !== state.identity.did || request.credentialFingerprint !== state.identity.fingerprint)
        || !acknowledged.has(signature(request));
    }
    for (const control of Array.from(dialog.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input,button'))) control.disabled = occupied();
    button('confirm-identity-backup').disabled = blocked || (backupMode === 'backup' ? !state?.configured && !readFailure : !state || state.configured);
  }
  function appendDetail(parent: HTMLElement, label: string, value: string): void {
    const row = document.createElement('p'); row.className = 'connection-info'; const name = document.createElement('strong'); name.textContent = label + ': ';
    row.append(name, document.createTextNode(value)); parent.append(row);
  }
  function render(): void {
    el('identity-status').textContent = !supported ? 'Installed-app sign-in unavailable in this version' : recovery() ? 'Check your sign-in key before continuing' : !state ? 'Sign-in status unavailable' : state.configured ? 'Your sign-in key is on this computer' : 'No sign-in key created';
    el('identity-create-fields').hidden = !supported || state?.configured === true;
    el('identity-key-details').hidden = !state?.identity;
    el('identity-fingerprint').textContent = state?.identity?.fingerprint ?? '';
    el('identity-public-did').textContent = state?.identity?.did ?? '';
    el('identity-recovery-warning').hidden = !recovery();
    el('identity-empty').hidden = !state || !!state.pending.length;
    if (forgetFingerprint !== currentFingerprint()) { forgetFingerprint = undefined; input('identity-forget-consent').checked = false; }
    el('identity-forget-review').hidden = !forgetFingerprint;
    const pending = el('identity-pending'); pending.replaceChildren();
    const validSignatures = new Set(state?.pending.map(signature));
    for (const acknowledgedSignature of acknowledged) if (!validSignatures.has(acknowledgedSignature)) acknowledged.delete(acknowledgedSignature);
    for (const request of state?.pending ?? []) {
      const card = document.createElement('article'); card.className = 'connection-card'; card.style.overflowWrap = 'anywhere';
      const linking = request.purpose === 'link';
      const heading = document.createElement('h3'); heading.textContent = linking ? 'Add this PC key to your existing account' : request.clientName + ' wants to sign in'; card.append(heading);
      appendDetail(card, 'Identity provider', request.identityOrigin);
      if (request.purpose === 'link') {
        const explanation = document.createElement('p'); explanation.textContent = 'Add a sign-in method to the account below. Your account, Hallowmarch character, progress and hosted data stay with that account.'; card.append(explanation);
        appendDetail(card, 'Existing account name', request.owner.displayName); appendDetail(card, 'Account ID', request.owner.userId);
        appendDetail(card, 'Account DID', request.owner.did); appendDetail(card, 'Web identity', request.owner.webId); appendDetail(card, 'Hosted pod', request.owner.podUrl);
        appendDetail(card, 'PC key identity', request.credentialDid); appendDetail(card, 'PC key fingerprint', request.credentialFingerprint);
        if (request.credentialDid !== state?.identity?.did || request.credentialFingerprint !== state?.identity?.fingerprint) {
          const warning = document.createElement('p'); warning.className = 'bridge-disclosure'; warning.textContent = 'This request no longer matches the key on this PC. Decline it and start again from your existing account.'; card.append(warning);
        }
      } else {
        appendDetail(card, 'App identifier', request.clientId); appendDetail(card, 'Sign-in relay', request.relayOrigin);
        appendDetail(card, 'Return to site', request.redirectOrigin); appendDetail(card, 'Exact callback', request.redirectUri);
        appendDetail(card, 'Requested permissions', request.scopes.map(permissionLabel).join(', ')); appendDetail(card, 'Resource', request.resource ?? 'The provider’s default resource');
        appendDetail(card, 'Your PC key fingerprint', state?.identity?.fingerprint ?? 'Unavailable');
      }
      appendDetail(card, 'Expires', Number.isFinite(Date.parse(request.expiresAt)) ? new Date(request.expiresAt).toLocaleString() : 'Unavailable');
      const code = document.createElement('p'); code.className = 'bridge-url'; code.textContent = request.verificationCode; card.append(code);
      if (request.state === 'completing') { const finishing = document.createElement('p'); finishing.textContent = linking ? 'Adding this PC key…' : 'Finishing sign-in…'; card.append(finishing); }
      else {
        const check = document.createElement('input'); check.type = 'checkbox'; check.id = 'identity-verify-' + request.id; check.checked = acknowledged.has(signature(request));
        const label = document.createElement('label'); label.className = 'scope-choice'; label.append(check, document.createTextNode(linking
          ? 'I checked this existing account, this PC key and the matching browser code. I understand this adds a sign-in method; it does not move my character, progress or data.'
          : 'I started this sign-in, checked the app and permissions, and the code matches my browser.')); card.append(label);
        const approve = document.createElement('button'); approve.className = 'primary'; approve.textContent = linking ? 'Add PC key' : 'Approve sign-in'; approve.dataset['identityApprove'] = request.id;
        check.addEventListener('change', () => { if (check.checked) acknowledged.add(signature(request)); else acknowledged.delete(signature(request)); controls(); });
        approve.addEventListener('click', () => {
          const current = state?.pending.find(item => item.id === request.id);
          if (!current || !state?.identity || signature(current) !== signature(request) || !acknowledged.has(signature(current)) || current.state !== 'waiting' || !fresh(current)
            || current.purpose === 'link' && (current.credentialDid !== state.identity.did || current.credentialFingerprint !== state.identity.fingerprint)) return;
          acknowledged.delete(signature(current)); void change(async () => { state = await identityApi.approveLocalIdentity(current.id, current.verificationCode); }, linking
            ? 'Your PC key was added to your existing account. Return to your browser.' : 'Sign-in approved. Return to your browser.');
        });
        const deny = document.createElement('button'); deny.className = 'secondary'; deny.textContent = 'Decline';
        deny.addEventListener('click', () => { void change(async () => { state = await identityApi.denyLocalIdentity(request.id); }, linking ? 'Adding this PC key was declined.' : 'Sign-in declined.'); });
        card.append(approve, deny);
      }
      pending.append(card);
    }
    controls();
  }
  async function change(operation: () => Promise<void>, success = ''): Promise<void> {
    if (occupied() || !available()) return;
    changing = true; epoch++; reading++; message(''); controls();
    try { await operation(); if (success) message(success); }
    catch {
      acknowledged.clear(); state = undefined; readFailure = true;
      try { state = await identityApi.localIdentityStatus(); readFailure = false; } catch { /* Do not present old approvals as current. */ }
      message('This identity change could not be confirmed. Check the status before trying again.', true);
    }
    finally { changing = false; render(); }
  }
  async function refresh(): Promise<void> {
    if (!supported || changing) return;
    const requested = ++reading; const began = epoch;
    try {
      const value = await identityApi.localIdentityStatus();
      if (requested !== reading || began !== epoch) return;
      state = value; if (readFailure) message(''); readFailure = false;
      if (!extensionsLoaded) {
        try {
          const ids = await identityApi.identityExtensionIds();
          if (requested !== reading || began !== epoch) return;
          if (!extensionsDirty) el<HTMLTextAreaElement>('identity-extension-ids').value = ids.join('\n'); extensionsLoaded = true;
        } catch { if (requested === reading && began === epoch) message('Browser sign-in access could not be checked. Refresh before changing it.', true); }
      }
    } catch { if (requested === reading && began === epoch) { state = undefined; readFailure = true; acknowledged.clear(); message('Your sign-in identity could not be checked. Refresh to try again.', true); } }
    if (requested === reading && began === epoch) render();
  }
  function beginBackup(mode: 'backup' | 'restore'): void {
    if (occupied() || !available() || (mode === 'backup' ? !state?.configured && !readFailure : !state || state.configured)) return;
    backupMode = mode; clearPassphrases(); dialogMessage('');
    el('identity-backup-title').textContent = mode === 'backup' ? 'Back up your sign-in identity' : 'Restore your sign-in identity';
    el('identity-backup-intro').textContent = mode === 'backup' ? 'This separate encrypted file protects your sign-in key. Keep both the backup and its passphrase somewhere safe.'
      : 'Choose your identity backup to recover the same sign-in key. This does not restore notes or change website account ownership.';
    el('identity-passphrase-confirmation-field').hidden = mode === 'restore';
    button('confirm-identity-backup').textContent = mode === 'backup' ? 'Choose where to save' : 'Choose identity backup';
    controls(); context.openDialog(dialog); input('identity-passphrase').focus();
  }
  button('refresh-identity').addEventListener('click', () => { void refresh(); });
  button('open-identity-dashboard').addEventListener('click', () => {
    if (occupied() || typeof api.openHosted !== 'function') return;
    void api.openHosted().catch(() => message('Your hosted account settings could not be opened. Try again.', true));
  });
  input('identity-create-consent').addEventListener('change', controls);
  button('create-local-identity').addEventListener('click', () => {
    if (!input('identity-create-consent').checked || state?.configured || !state) return;
    void change(async () => { state = await identityApi.setupLocalIdentity(); input('identity-create-consent').checked = false; }, 'Your PC key is ready. Add it to your existing account from its account settings, and keep an encrypted identity backup.');
  });
  el('identity-extension-ids').addEventListener('input', () => { extensionsDirty = true; input('identity-extension-consent').checked = false; controls(); });
  input('identity-extension-consent').addEventListener('change', controls);
  el('identity-extensions-form').addEventListener('submit', event => {
    event.preventDefault(); if (!state?.configured || !extensionsLoaded || !input('identity-extension-consent').checked) return;
    const ids = [...new Set(el<HTMLTextAreaElement>('identity-extension-ids').value.trim().split(/\s+/).filter(Boolean))];
    if (ids.length > 4 || ids.some(id => !/^[a-p]{32}$/.test(id))) { message('Use the extension ID shown in Interego Wallet: 32 lowercase letters from a to p, one per line. You may allow up to 4.', true); return; }
    void change(async () => { const saved = await identityApi.setIdentityExtensionIds(ids); el<HTMLTextAreaElement>('identity-extension-ids').value = saved.join('\n'); extensionsDirty = false; input('identity-extension-consent').checked = false; }, ids.length ? 'These extensions may request sign-in. Each request still needs your approval here.' : 'Browser sign-in requests are turned off.');
  });
  button('backup-local-identity').addEventListener('click', () => beginBackup('backup'));
  button('restore-local-identity').addEventListener('click', () => beginBackup('restore'));
  button('cancel-identity-backup').addEventListener('click', () => { if (!occupied()) { clearPassphrases(); context.closeDialog(dialog); } });
  dialog.addEventListener('cancel', event => { if (occupied()) event.preventDefault(); else clearPassphrases(); });
  dialog.addEventListener('close', clearPassphrases);
  el('identity-backup-form').addEventListener('submit', event => {
    event.preventDefault(); if (occupied() || !available() || (backupMode === 'backup' ? !state?.configured && !readFailure : !state || state.configured)) return;
    const passphrase = input('identity-passphrase').value;
    if (passphrase.length < 12) { dialogMessage('Use a passphrase with at least 12 characters.', true); return; }
    if (backupMode === 'backup' && passphrase !== input('identity-passphrase-confirmation').value) { dialogMessage('Those passphrases do not match.', true); return; }
    const mode = backupMode; clearPassphrases();
    void change(async () => {
      try {
        const result = await (mode === 'backup' ? identityApi.backupLocalIdentity(passphrase) : identityApi.restoreLocalIdentity(passphrase)); state = result.status; readFailure = false;
        if (result.cancelled) { dialogMessage('No file was selected. Enter your passphrase again to continue.'); return; }
        context.closeDialog(dialog); message(mode === 'backup' ? 'Your identity backup is saved. Keep its passphrase separately in a safe place.' : 'Your original sign-in key is restored. Compare its fingerprint before using it.');
      } catch {
        try { state = await identityApi.localIdentityStatus(); readFailure = false; } catch { state = undefined; readFailure = true; acknowledged.clear(); }
        dialogMessage(mode === 'backup' ? 'Your identity backup could not be saved. Try again.' : 'The identity could not be restored. Check the backup and its passphrase.', true);
      }
      finally { clearPassphrases(); }
    });
  });
  button('forget-local-identity').addEventListener('click', () => { if (!occupied() && (state?.configured || readFailure)) { forgetFingerprint = currentFingerprint(); input('identity-forget-consent').checked = false; render(); } });
  input('identity-forget-consent').addEventListener('change', controls);
  button('cancel-forget-local-identity').addEventListener('click', () => { forgetFingerprint = undefined; input('identity-forget-consent').checked = false; render(); });
  button('confirm-forget-local-identity').addEventListener('click', () => {
    if (!forgetFingerprint || forgetFingerprint !== currentFingerprint() || !input('identity-forget-consent').checked) return;
    void change(async () => { state = await identityApi.forgetLocalIdentity(); readFailure = false; forgetFingerprint = undefined; acknowledged.clear(); }, 'The sign-in key was removed from this computer. Notes and website accounts were kept.');
  });
  window.addEventListener('pagehide', clearPassphrases);
  render(); return { refresh, updateAvailability: controls };
}
