import type { DesktopApi, LocalNote, PodStatus } from './types.js';
import type { AgentClient, AgentConnection, AgentPermission, AgentSetup } from './agent-types.js';
import { installBridgeUi } from './bridge-renderer.js';
import { installFederationUi } from './federation-renderer.js';
import { installIdentityUi } from './identity-renderer.js';

const element = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing application element: ${id}`);
  return found as T;
};
const button = (id: string): HTMLButtonElement => element<HTMLButtonElement>(id);
const input = (id: string): HTMLInputElement => element<HTMLInputElement>(id);
const api: DesktopApi = window.interego;
const noteForm = element<HTMLFormElement>('note-form');
const backupForm = element<HTMLFormElement>('backup-form');
const backupDialog = element<HTMLDialogElement>('backup-dialog');
const noteDialog = element<HTMLDialogElement>('note-dialog');
const connectionDialog = element<HTMLDialogElement>('connection-dialog');
const connectionForm = element<HTMLFormElement>('connection-form');
let status: PodStatus | null = null;
let notes: readonly LocalNote[] = [];
let notesLoaded = false;
let notesError = false;
let busy: string | null = null;
type Page = 'memory' | 'connections' | 'identity' | 'backup' | 'settings';
let currentPage: Page = 'memory';
let backupMode: 'backup' | 'restore' = 'backup';
let statusRequest = 0;
let noteRequest = 0;
let stateEpoch = 0;
let pollTimer: ReturnType<typeof setTimeout> | undefined;
let previousFocus: HTMLElement | null = null;
let pendingFocus: HTMLElement | null = null;
type NoticeSource = 'action' | 'status' | 'notes' | 'profile' | 'connections';
let noticeSource: NoticeSource | null = null;
let profileErrorSignature: string | null = null;
let connections: readonly AgentConnection[] = [];
let connectionsLoaded = false;
let connectionsError = false;
let connectionRequest = 0;
let setupRequest = 0;
let selectedConnection: AgentConnection | null = null;
let selectedConnectionId: string | null = null;
let setup: AgentSetup | null = null;
let setupLoading = false;
let notePollInFlight = false;
let previousClient: AgentClient = 'chatgpt-desktop';

const CLIENT_NAMES: Record<AgentClient, string> = {
  'chatgpt-desktop': 'ChatGPT desktop', codex: 'Codex', 'claude-code': 'Claude Code',
  'claude-desktop': 'Claude Desktop', 'grok-build': 'Grok Build', openclaw: 'OpenClaw', other: 'Other local MCP app',
};
const CLIENT_HELP: Record<AgentClient, string> = {
  'chatgpt-desktop': 'Uses local tools through the setup shared with Codex. Keep Interego open while you use it.',
  codex: 'Connect Codex running on this computer. Keep Interego open while you use it.',
  'claude-code': 'Connect the local Claude Code app. Keep Interego open while you use it.',
  'claude-desktop': 'Add the local connection to Claude Desktop, then restart that app if its setup asks you to.',
  'grok-build': 'For the local Grok Build client. Web Grok and cloud-hosted bots need a different connection route.',
  openclaw: 'Run the connector on this computer. A cloud-hosted bot cannot reach this local pod directly.',
  other: 'For an MCP app running on this computer. Follow its instructions for adding local tools.',
};
const CONNECTION_LABELS: Record<AgentConnection['state'], string> = {
  waiting: 'Waiting for first use', active: 'Access allowed', revoked: 'Disconnected', expired: 'Expired', 'pod-changed': 'Different space',
};
const usable = (connection: AgentConnection | null): boolean => !!connection && ['waiting', 'active'].includes(connection.state);
const bridgeUi = installBridgeUi(api, {
  pod: () => status, locallyBusy: () => busy !== null, openDialog, closeDialog,
  showConnections: () => selectPage('connections'),
  onAccessChanged: () => { drawConnections(); void loadConnections(); },
});
const federationUi = installFederationUi(api, { pod: () => status, locallyBusy: () => busy !== null });
const identityUi = installIdentityUi(api, { pod: () => status, locallyBusy: () => busy !== null, openDialog, closeDialog });

function connectionDate(value: string): string {
  return Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(new Date(value)) : 'Unavailable';
}

function connectionMessage(message: string, error = false): void {
  element('connection-message').hidden = false;
  element('connection-message').classList.toggle('error', error);
  element('connection-message').setAttribute('role', error ? 'alert' : 'status');
  element('connection-message').textContent = message;
}

function setupState(): void {
  element('connection-setup-state').textContent = selectedConnection
    ? CONNECTION_LABELS[selectedConnection.state] : 'Connection unavailable';
  element('connection-setup-state').classList.toggle('inactive', !usable(selectedConnection));
  element('connection-setup-help').textContent = !usable(selectedConnection)
    ? 'This connection cannot access your notes. Create a new connection if you want to allow access again.'
    : selectedConnection?.lastUsedAt ? `Last used ${connectionDate(selectedConnection.lastUsedAt)}.`
      : 'Finish setup in your app. Interego will show when this connection is first used.';
}

function drawConnections(): void {
  const list = element('connections-list');
  list.replaceChildren();
  element('connections-empty').hidden = connectionsLoaded && !connectionsError && connections.length > 0;
  if (connectionsError) {
    element('connections-empty-title').textContent = 'Connections could not be checked';
    element('connections-empty-description').textContent = 'Refresh to see which apps have access. Existing permissions have not been changed.';
  } else if (!connectionsLoaded) {
    element('connections-empty-title').textContent = 'Checking your connections…';
    element('connections-empty-description').textContent = 'Reading the apps allowed to use your space.';
  } else if (connections.length === 0) {
    element('connections-empty-title').textContent = 'Your AI, your choice';
    element('connections-empty-description').textContent = 'No apps have been added. Choose an app and the access you want to allow.';
  } else {
    for (const connection of connections) {
      const card = document.createElement('article');
      card.className = 'connection-card card';
      card.dataset.connectionId = connection.id;
      const top = document.createElement('div'); top.className = 'connection-top';
      const identity = document.createElement('div');
      const name = document.createElement('h3'); name.className = 'connection-name'; name.textContent = connection.name;
      const client = document.createElement('p'); client.className = 'connection-client'; client.textContent = bridgeUi.isWebConnection(connection.id) ? 'Web assistant' : CLIENT_NAMES[connection.client];
      identity.append(name, client);
      const badge = document.createElement('span'); badge.className = `connection-badge${usable(connection) ? '' : ' inactive'}`;
      badge.textContent = CONNECTION_LABELS[connection.state]; top.append(identity, badge);
      const permissions = document.createElement('p'); permissions.className = 'connection-permissions';
      permissions.textContent = connection.permissions.map(value => value === 'notes:read' ? 'Read notes' : 'Save new notes').join(' · ');
      const meta = document.createElement('p'); meta.className = 'connection-meta';
      meta.textContent = `Expires ${connectionDate(connection.expiresAt)}${connection.lastUsedAt ? ` · Last used ${connectionDate(connection.lastUsedAt)}` : ''}`;
      card.append(top, permissions, meta);
      if (usable(connection)) {
        const actions = document.createElement('div'); actions.className = 'connection-actions';
        const configure = document.createElement('button'); configure.className = 'secondary'; configure.textContent = bridgeUi.isWebConnection(connection.id) ? 'Web setup' : 'Setup details';
        configure.setAttribute('aria-label', `Setup details for ${connection.name}`);
        configure.addEventListener('click', () => { if (bridgeUi.isWebConnection(connection.id)) bridgeUi.openSetup(); else beginConnection(connection); });
        const revoke = document.createElement('button'); revoke.className = 'danger'; revoke.textContent = 'Disconnect';
        revoke.setAttribute('aria-label', `Disconnect ${connection.name}`);
        revoke.addEventListener('click', () => {
          void action('connection-revoke', async () => {
            connectionRequest++; // A read started before revocation cannot restore an old active card.
            try { await api.revokeConnection(connection.id); }
            catch (error) { await loadConnections(); throw error; }
            const refreshed = await loadConnections();
            notice(refreshed ? 'This connection is disconnected. Future access is blocked.'
              : 'This connection is disconnected. Refresh the list to see its updated status.');
          }, 'The access change could not be confirmed. Refresh connections before trying again.');
        });
        actions.append(configure, revoke); card.append(actions);
      }
      list.append(card);
    }
  }
  controls();
}

async function loadConnections(): Promise<boolean> {
  if (!status?.configured) return false;
  const requested = ++connectionRequest;
  try {
    const received = await api.connections();
    if (requested !== connectionRequest || !status?.configured) return false;
    connections = received; connectionsLoaded = true; connectionsError = false;
    clearNotice('connections');
    if (selectedConnectionId) {
      selectedConnection = received.find(value => value.id === selectedConnectionId) ?? null;
      if (!usable(selectedConnection)) {
        setupRequest++; setup = null; setupLoading = false;
        element('connection-setup-loading').hidden = true;
        element('connection-setup-configuration').textContent = '';
        element('connection-setup-command').textContent = '';
        element('connection-setup-steps').replaceChildren();
        button('retry-connection-setup').hidden = true;
      }
      setupState();
    }
    drawConnections();
    return true;
  } catch (error) {
    if (requested !== connectionRequest || !status?.configured) return false;
    connectionsError = true;
    drawConnections();
    notice('Your connections could not be checked. Refresh to try again.', error, true, 'connections');
    return false;
  }
}

async function loadSetup(id: string): Promise<void> {
  const requested = ++setupRequest;
  setup = null; setupLoading = true;
  element('connection-message').hidden = true;
  button('retry-connection-setup').hidden = true;
  element('connection-setup-loading').hidden = false;
  element('connection-setup-configuration').textContent = '';
  element('connection-setup-command').textContent = '';
  controls();
  try {
    const received = await api.connectionSetup(id);
    if (requested !== setupRequest || selectedConnectionId !== id || !connectionDialog.open) return;
    if (received.connectionId !== id) throw new Error('The setup did not match the selected connection.');
    if (!usable(selectedConnection)) return;
    setup = received;
    element('connection-dialog-title').textContent = received.title;
    element('connection-setup-location').textContent = received.configLocation;
    const steps = element('connection-setup-steps'); steps.replaceChildren();
    for (const text of received.steps) { const item = document.createElement('li'); item.textContent = text; steps.append(item); }
    element('connection-setup-configuration').textContent = received.configuration;
    element('connection-setup-command').textContent = received.command ?? '';
    element('connection-setup-command').hidden = !received.command;
    setupState();
  } catch {
    if (requested !== setupRequest || selectedConnectionId !== id || !connectionDialog.open) return;
    button('retry-connection-setup').hidden = false;
    connectionMessage('The connection is saved, but its setup could not be loaded. Try again.', true);
  } finally {
    if (requested === setupRequest) { setupLoading = false; element('connection-setup-loading').hidden = true; controls(); }
  }
}

function clientHelp(previous?: AgentClient): void {
  const client = element<HTMLSelectElement>('connection-client').value as AgentClient;
  if (!(client in CLIENT_NAMES)) return;
  if (!input('connection-name').value || (previous && input('connection-name').value === CLIENT_NAMES[previous])) input('connection-name').value = CLIENT_NAMES[client];
  element('connection-client-help').textContent = CLIENT_HELP[client];
}

function beginConnection(existing?: AgentConnection): void {
  if (busy || !status?.configured || (!existing && status.restorePending) || (existing && !usable(existing))) return;
  setupRequest++; setup = null; setupLoading = false;
  selectedConnection = existing ?? null; selectedConnectionId = existing?.id ?? null;
  element('connection-message').hidden = true;
  element('connection-setup-steps').replaceChildren();
  element('connection-setup-location').textContent = '';
  element('connection-setup-configuration').textContent = '';
  element('connection-setup-command').textContent = '';
  element<HTMLDetailsElement>('connection-setup-details').open = false;
  element('connection-form').hidden = !!existing;
  element('connection-setup').hidden = !existing;
  element('connection-dialog-title').textContent = existing ? `Set up ${existing.name}` : 'Connect your AI app';
  element('connection-dialog-intro').textContent = existing ? 'This connection has only the permissions you allowed.'
    : 'Choose an app on this computer, then decide what it can do.';
  if (!existing) {
    connectionForm.reset(); input('connection-name').value = '';
    previousClient = element<HTMLSelectElement>('connection-client').value as AgentClient;
    clientHelp();
  }
  controls();
  openDialog(connectionDialog);
  if (existing) { setupState(); button('close-connection').focus(); void loadSetup(existing.id); }
  else element<HTMLSelectElement>('connection-client').focus();
}

function notice(message: string, detail?: unknown, error = false, source: NoticeSource = 'action'): void {
  noticeSource = source;
  const region = element('notice');
  region.hidden = false;
  region.classList.toggle('error', error);
  region.setAttribute('role', error ? 'alert' : 'status');
  element('notice-message').textContent = message;
  const information = detail instanceof Error ? detail.message : typeof detail === 'string' ? detail : '';
  element('notice-details').hidden = !information;
  element('notice-detail-text').textContent = information;
}

function clearNotice(source?: NoticeSource): void {
  if (source && noticeSource !== source) return;
  noticeSource = null;
  element('notice').hidden = true;
  element('notice-message').textContent = '';
  element('notice-detail-text').textContent = '';
  element<HTMLDetailsElement>('notice-details').open = false;
}

function dateLabel(value: string, full = false): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return 'Saved on this computer';
  return new Intl.DateTimeFormat(undefined, {
    month: full ? 'long' : 'short', day: 'numeric', ...(full ? { year: 'numeric' } : {}),
  }).format(parsed);
}

function openDialog(dialog: HTMLDialogElement): void {
  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
}

function closeDialog(dialog: HTMLDialogElement): void {
  if (typeof dialog.close === 'function') dialog.close();
  else dialog.removeAttribute('open');
  if (dialog === backupDialog) {
    input('backup-passphrase').value = '';
    input('backup-confirmation').value = '';
  }
  if (dialog === noteDialog) {
    element('read-note-title').textContent = '';
    element('read-note-body').textContent = '';
    element('read-note-date').textContent = '';
  }
  if (dialog === connectionDialog) {
    setupRequest++; setup = null; setupLoading = false;
    selectedConnectionId = null; selectedConnection = null;
    element('connection-setup-configuration').textContent = '';
    element('connection-setup-command').textContent = '';
    element('connection-message').hidden = true;
  }
  if (previousFocus?.matches(':disabled')) pendingFocus = previousFocus;
  else previousFocus?.focus();
  previousFocus = null;
}

function drawNotes(): void {
  const list = element('notes-list');
  list.replaceChildren();
  const available = !!status?.running;
  element('notes-empty').hidden = available && notesLoaded && !notesError && notes.length > 0;
  element('note-count').textContent = available && notesLoaded && !notesError
    ? String(notes.length) : '—';
  button('retry-notes').hidden = !available || !notesError;
  if (!available) {
    element('empty-title').textContent = status?.restorePending ? "Let's finish restoring" : 'Your notes are right here';
    element('empty-description').textContent = status?.restorePending
      ? 'Choose the same backup to safely finish restoring your notes.' : 'Start Interego to read and save notes.';
  } else if (notesError) {
    element('empty-title').textContent = 'Your notes could not be read';
    element('empty-description').textContent = 'Try again to refresh your saved notes.';
  } else if (!notesLoaded) {
    element('empty-title').textContent = 'Opening your notes…';
    element('empty-description').textContent = 'Reading your saved notes from this computer.';
  } else {
    element('empty-title').textContent = 'Your space is ready';
    element('empty-description').textContent = 'Save your first note. It will be waiting for you here.';
    for (const note of notes) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'note-item';
      item.setAttribute('aria-label', `Read note: ${note.title}`);
      const title = document.createElement('span');
      title.className = 'note-title';
      title.textContent = note.title;
      const preview = document.createElement('span');
      preview.className = 'note-preview';
      preview.textContent = note.body.length > 150 ? `${note.body.slice(0, 150)}…` : note.body;
      const date = document.createElement('span');
      date.className = 'note-date';
      date.textContent = dateLabel(note.updatedAt);
      item.append(title, preview, date);
      if (note.author) {
        const author = document.createElement('span'); author.className = 'note-author';
        author.textContent = `Saved by ${note.author.name}`;
        item.append(author);
      }
      item.addEventListener('click', () => {
        element('read-note-title').textContent = note.title;
        element('read-note-body').textContent = note.body;
        element('read-note-date').textContent = `Saved ${dateLabel(note.updatedAt, true)}${note.author ? ` · Saved by ${note.author.name}` : ''}`;
        openDialog(noteDialog);
        button('close-note').focus();
      });
      list.append(item);
    }
  }
}

function controls(): void {
  const occupied = busy !== null;
  const running = status?.running ?? false;
  const moving = status?.state === 'starting' || status?.state === 'stopping';
  for (const id of ['setup-local', 'welcome-hosted', 'welcome-restore', 'open-hosted', 'connections-hosted']) button(id).disabled = occupied;
  button('setup-local').disabled = occupied || !!status?.restorePending;
  button('setup-local').textContent = busy === 'setup' ? 'Setting up your space…' : 'Set up on this computer →';
  element('setup-progress').hidden = busy !== 'setup';
  const toggle = button('toggle-running');
  toggle.disabled = occupied || moving;
  toggle.textContent = busy === 'stop' || status?.state === 'stopping' ? 'Stopping…'
    : busy === 'start' || status?.state === 'starting' ? 'Starting…'
    : status?.restorePending ? 'Finish restore' : running ? 'Stop Interego' : status?.state === 'error' ? 'Try again' : 'Start Interego';
  input('note-title').disabled = occupied || !running;
  element<HTMLTextAreaElement>('note-body').disabled = occupied || !running;
  button('save-note').disabled = occupied || !running;
  button('save-note').textContent = busy === 'save' ? 'Saving…' : 'Save note →';
  button('backup-notes').disabled = occupied || !running;
  button('open-folder').disabled = occupied || !status?.configured;
  button('retry-notes').disabled = occupied;
  element('backup-availability').textContent = status?.restorePending
    ? 'Finish restoring your notes before creating a new backup.' : running
    ? 'Restore a notes backup when setting up a new space. Your existing space is kept unchanged.'
    : 'Start Interego to back up your saved notes.';
  button('confirm-backup').disabled = occupied;
  button('cancel-backup').disabled = occupied;
  input('backup-passphrase').disabled = occupied;
  input('backup-confirmation').disabled = occupied;
  button('confirm-backup').textContent = occupied && (busy === 'backup' || busy === 'restore') ? 'Please wait…'
    : backupMode === 'backup' ? 'Choose where to save' : 'Choose your backup';
  const mayCreate = !!status?.configured && !status.restorePending;
  button('add-connection').disabled = occupied || !mayCreate;
  button('refresh-connections').disabled = occupied || !status?.configured;
  element('connections-availability').textContent = status?.restorePending
    ? 'Finish restoring before adding an app. Existing connections can still be disconnected.'
    : !running ? 'Your connections can be managed while Interego is stopped. Apps can use notes when your local space is running.'
      : 'Choose which apps can read or save notes. You can disconnect them at any time.';
  for (const control of Array.from(element('connections-list').querySelectorAll<HTMLButtonElement>('button'))) control.disabled = occupied;
  for (const id of ['connection-client', 'connection-expiry']) element<HTMLSelectElement>(id).disabled = occupied;
  for (const id of ['connection-name', 'permission-read', 'permission-create']) input(id).disabled = occupied;
  button('create-connection').disabled = occupied || !mayCreate || (!input('permission-read').checked && !input('permission-create').checked);
  button('create-connection').textContent = busy === 'connection-create' ? 'Creating…' : 'Create connection';
  for (const id of ['cancel-connection', 'close-connection']) button(id).disabled = occupied;
  button('copy-connection-config').disabled = occupied || setupLoading || !setup || !usable(selectedConnection);
  button('copy-connection-command').disabled = occupied || setupLoading || !setup?.command || !usable(selectedConnection);
  button('copy-connection-command').hidden = !setup?.command;
  button('retry-connection-setup').disabled = occupied || setupLoading || !usable(selectedConnection);
  element('connection-consent').textContent = input('permission-read').checked
    ? 'If this app uses an online AI service, notes it reads may be sent to that service. Your pod stays on this computer.'
    : input('permission-create').checked ? 'This app may save new notes. It will not be allowed to read your existing notes.'
      : 'Choose at least one permission to continue.';
  document.body.setAttribute('aria-busy', String(occupied));
  bridgeUi.updateAvailability();
  federationUi.updateAvailability();
  identityUi.updateAvailability();
}

function applyStatus(next: PodStatus): void {
  const wasRunning = !!status?.running;
  if (status?.configured !== next.configured) {
    connectionRequest++; connections = []; connectionsLoaded = false; connectionsError = false;
    element('connections-list').replaceChildren();
    element('connections-empty').hidden = false;
    if (!next.configured && connectionDialog.open) closeDialog(connectionDialog);
  }
  if (status?.state !== next.state || status?.configured !== next.configured) stateEpoch++;
  status = next;
  element('loading-screen').hidden = true;
  element('welcome').hidden = next.configured;
  element('shell').hidden = !next.configured;
  const descriptions: Record<PodStatus['state'], [string, string]> = {
    unconfigured: ['Your private space is ready to begin', 'Saved on this computer. Federation is off.'],
    stopped: ['Resting on this computer', 'Your saved notes are safe here. Start when you are ready.'],
    starting: ['Getting your space ready…', 'Your local space is starting.'],
    running: ['Ready on this computer', status?.federationEnabled ? 'Your saved notes are encrypted. Selected pod sharing is on.' : 'Your saved notes are encrypted. Federation is off.'],
    stopping: ['Putting your space to rest…', 'Finishing up safely on this computer.'],
    error: ['Your space needs a moment', 'Interego could not start. Try again when you are ready.'],
  };
  element('status-label').textContent = next.restorePending ? 'Finish restoring your notes' : descriptions[next.state][0];
  element('status-description').textContent = next.restorePending
    ? 'Choose the same backup to safely finish your restore.' : descriptions[next.state][1];
  if (next.state === 'error' && next.running && !next.restorePending) {
    element('status-label').textContent = 'Running on this computer';
    element('status-description').textContent = 'Your last action needs another try. Your saved notes are kept here.';
  }
  if (next.state === 'error' && !next.configured && !next.restorePending) {
    const signature = next.lastError ?? 'unavailable-profile';
    if (signature !== profileErrorSignature) {
      notice('Your local space could not be opened. Your data has been kept unchanged.', next.lastError, true, 'profile');
    }
    profileErrorSignature = signature;
  } else {
    profileErrorSignature = null;
    clearNotice('profile');
  }
  element('status-indicator').className = `status-indicator ${next.state === 'error' ? 'error'
    : next.state === 'starting' || next.state === 'stopping' ? 'busy' : next.running ? '' : 'off'}`;
  element('status-icon').classList.toggle('error', next.state === 'error');
  if (!next.running) {
    notes = [];
    notesLoaded = false;
    notesError = false;
    noteRequest++;
    if (noteDialog.open) closeDialog(noteDialog);
  }
  controls();
  drawNotes();
  if (next.running && !wasRunning) void loadNotes();
}

async function loadNotes(): Promise<boolean> {
  if (!status?.running) return false;
  const requested = ++noteRequest;
  const epoch = stateEpoch;
  try {
    const received = await api.notes();
    if (requested !== noteRequest || epoch !== stateEpoch || !status?.running) return false;
    notes = received;
    notesLoaded = true;
    notesError = false;
    clearNotice('notes');
    drawNotes();
    return true;
  } catch (error) {
    if (requested !== noteRequest || epoch !== stateEpoch || !status?.running) return false;
    notesError = true;
    drawNotes();
    notice('Your notes could not be read. Try refreshing them.', error, true, 'notes');
    return false;
  }
}

function schedulePoll(): void {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = setTimeout(() => { void refreshStatus(false); }, 3_000);
}

async function refreshStatus(initial: boolean): Promise<void> {
  void bridgeUi.refresh();
  void federationUi.refresh();
  void identityUi.refresh();
  if (busy) { schedulePoll(); return; }
  const requested = ++statusRequest;
  try {
    if (!api) throw new Error('Open the installed Interego application to use your local space.');
    const next = await api.status();
    if (requested === statusRequest) {
      clearNotice('status'); applyStatus(next);
      if (currentPage === 'connections') await loadConnections();
      if (currentPage === 'memory' && next.running && notesLoaded && next.noteCount !== notes.length && !notePollInFlight) {
        notePollInFlight = true;
        void loadNotes().finally(() => { notePollInFlight = false; });
      }
    }
  } catch (error) {
    if (requested !== statusRequest) return;
    if (initial || !status) {
      element('loading-message').textContent = 'Your space could not be opened.';
      button('retry-load').hidden = false;
      element('loading-screen').querySelector('.spinner')?.setAttribute('hidden', '');
    }
    notice('Interego could not check your local space. Please try again.', error, true, 'status');
  } finally { schedulePoll(); }
}

async function action(name: string, operation: () => Promise<void>, failure: string,
  onFailure?: (error: unknown) => void): Promise<void> {
  if (busy) return;
  busy = name;
  statusRequest++;
  clearNotice();
  controls();
  try { await operation(); }
  catch (error) {
    if (['setup', 'start', 'stop', 'restore'].includes(name)) {
      // A failed start can still leave a configured space; an interrupted restore
      // can leave a resumable commit. Read that state before choosing the next action.
      try { applyStatus(await api.status()); } catch { /* retain the last established state */ }
    }
    if (onFailure) onFailure(error); else notice(failure, error, true);
  }
  finally {
    busy = null;
    controls();
    if (pendingFocus && !pendingFocus.closest('[hidden]')) pendingFocus.focus();
    else if (backupDialog.open) input('backup-passphrase').focus();
    else if (connectionDialog.open) {
      if (setup && usable(selectedConnection)) button('copy-connection-config').focus();
      else if (selectedConnectionId) button('close-connection').focus();
      else input('connection-name').focus();
    }
    else if (['setup', 'restore', 'save'].includes(name) && status?.running && !element('memory-page').hidden) input('note-title').focus();
    pendingFocus = null;
    schedulePoll();
  }
}

function selectPage(next: Page): void {
  currentPage = next;
  const headings = {
    memory: ['Your memory', 'A little space for what matters.'],
    connections: ['Your AI, your memory', 'Choose the apps you want to let in.'],
    identity: ['Your identity', 'A sign-in key you keep, with a choice for every website.'],
    backup: ['Backup & recovery', 'Keep a safe copy of your saved notes.'],
    settings: ['Your space, your way', 'A few things to make yourself at home.'],
  };
  element('page-title').textContent = headings[next][0]!;
  element('page-description').textContent = headings[next][1]!;
  for (const name of ['memory', 'connections', 'identity', 'backup', 'settings'] as const) {
    element(`${name}-page`).hidden = next !== name;
    if (name === next) button(`nav-${name}`).setAttribute('aria-current', 'page');
    else button(`nav-${name}`).removeAttribute('aria-current');
  }
  element('settings-ai-disclosure').hidden = next !== 'settings';
  if (next === 'connections') void loadConnections();
  if (next === 'identity') void identityUi.refresh();
}

function dialogMessage(message: string, error = true): void {
  const region = element('backup-dialog-error');
  region.hidden = false;
  region.className = error ? 'dialog-error' : 'dialog-hint';
  region.setAttribute('role', error ? 'alert' : 'status');
  region.textContent = message;
}

function beginBackup(mode: typeof backupMode): void {
  if (busy || !status || (mode === 'restore' && status.configured && !status.restorePending) || (mode === 'backup' && !status.running)) return;
  backupMode = mode;
  backupForm.reset();
  element('backup-dialog-error').hidden = true;
  element('confirmation-field').hidden = mode === 'restore';
  input('backup-confirmation').required = mode === 'backup';
  element('backup-dialog-title').textContent = mode === 'backup' ? 'Back up your notes' : 'Welcome your notes back';
  element('backup-dialog-description').textContent = mode === 'backup'
    ? 'Choose a passphrase to protect your notes backup. Then choose where to save your copy.'
    : status.restorePending ? 'Choose the same backup to finish restoring. Your saved data is kept unchanged.'
      : 'Enter your backup passphrase, then choose your backup file. Your notes will be restored into a new space on this computer.';
  controls();
  openDialog(backupDialog);
  input('backup-passphrase').focus();
}

button('dismiss-notice').addEventListener('click', () => clearNotice());
button('retry-load').addEventListener('click', () => { void refreshStatus(true); });
button('setup-local').addEventListener('click', () => {
  void action('setup', async () => { applyStatus(await api.setup()); }, 'Your local space could not be set up. Please try again.');
});
button('toggle-running').addEventListener('click', () => {
  if (status?.restorePending) { beginBackup('restore'); return; }
  const stop = !!status?.running;
  void action(stop ? 'stop' : 'start', async () => {
    applyStatus(await (stop ? api.stop() : api.start()));
  }, stop ? 'Interego could not stop safely. Please try again.' : 'Your local space could not start. Please try again.');
});
button('retry-notes').addEventListener('click', () => { void loadNotes(); });
for (const name of ['memory', 'connections', 'identity', 'backup', 'settings'] as const) button(`nav-${name}`).addEventListener('click', () => selectPage(name));
for (const id of ['welcome-hosted', 'open-hosted', 'connections-hosted']) button(id).addEventListener('click', () => {
  void action('hosted', () => api.openHosted(), 'Hosted Interego could not be opened. Please try again.');
});
button('open-folder').addEventListener('click', () => {
  void action('folder', () => api.openDataFolder(), 'Your Interego folder could not be opened. Please try again.');
});
button('backup-notes').addEventListener('click', () => beginBackup('backup'));
button('welcome-restore').addEventListener('click', () => beginBackup('restore'));
button('cancel-backup').addEventListener('click', () => { if (!busy) closeDialog(backupDialog); });
button('close-note').addEventListener('click', () => closeDialog(noteDialog));
backupDialog.addEventListener('cancel', event => { event.preventDefault(); if (!busy) closeDialog(backupDialog); });
noteDialog.addEventListener('cancel', event => { event.preventDefault(); closeDialog(noteDialog); });
connectionDialog.addEventListener('cancel', event => { event.preventDefault(); if (!busy) closeDialog(connectionDialog); });
for (const id of ['cancel-connection', 'close-connection']) button(id).addEventListener('click', () => { if (!busy) closeDialog(connectionDialog); });
button('add-connection').addEventListener('click', () => beginConnection());
button('refresh-connections').addEventListener('click', () => { void loadConnections(); });
element<HTMLSelectElement>('connection-client').addEventListener('change', () => {
  clientHelp(previousClient);
  previousClient = element<HTMLSelectElement>('connection-client').value as AgentClient;
});
for (const id of ['permission-read', 'permission-create']) input(id).addEventListener('change', controls);
button('retry-connection-setup').addEventListener('click', () => { if (selectedConnectionId) void loadSetup(selectedConnectionId); });
for (const [id, format] of [['copy-connection-config', 'configuration'], ['copy-connection-command', 'command']] as const) {
  button(id).addEventListener('click', () => {
    const connectionId = selectedConnectionId;
    if (!connectionId || !setup || !usable(selectedConnection)) return;
    void action('connection-copy', async () => {
      await api.copyConnectionSetup(connectionId, format);
      if (selectedConnectionId === connectionId && connectionDialog.open) connectionMessage('Setup copied. Paste it into your app to finish connecting.');
    }, '', () => connectionMessage('Setup could not be copied. Please try again.', true));
  });
}
connectionForm.addEventListener('submit', event => {
  event.preventDefault();
  if (busy || selectedConnectionId || !status?.configured || status.restorePending) return;
  const name = input('connection-name').value.trim();
  const client = element<HTMLSelectElement>('connection-client').value as AgentClient;
  const days = Number(element<HTMLSelectElement>('connection-expiry').value);
  const permissions: AgentPermission[] = [];
  if (input('permission-read').checked) permissions.push('notes:read');
  if (input('permission-create').checked) permissions.push('notes:create');
  if (!name || name.length > 80 || !(client in CLIENT_NAMES) || ![7, 30, 90].includes(days) || !permissions.length) {
    connectionMessage('Choose an app, a connection name, and at least one permission.', true); return;
  }
  void action('connection-create', async () => {
    connectionRequest++;
    const created = await api.createConnection({ name, client, permissions, expiresInDays: days as 7 | 30 | 90 });
    selectedConnection = created; selectedConnectionId = created.id;
    element('connection-form').hidden = true; element('connection-setup').hidden = false;
    element('connection-dialog-intro').textContent = 'This connection has only the permissions you allowed.';
    setupState();
    await loadConnections();
    await loadSetup(created.id);
  }, '', () => connectionMessage('This connection could not be created. Your choices are still here.', true));
});

noteForm.addEventListener('submit', event => {
  event.preventDefault();
  if (!status?.running || busy) return;
  const title = input('note-title').value.trim();
  const body = element<HTMLTextAreaElement>('note-body').value;
  if (!title || !body.trim()) { notice('Give your note a title and a few words before saving.', undefined, true); return; }
  void action('save', async () => {
    await api.saveNote({ title, body });
    noteForm.reset();
    const refreshed = await loadNotes();
    notice(refreshed ? 'Your note is saved.' : 'Your note is saved. Refresh the list to see it.');
    input('note-title').focus();
  }, 'Your note could not be saved. Your draft is still here.');
});

backupForm.addEventListener('submit', event => {
  event.preventDefault();
  if (busy) return;
  const passphrase = input('backup-passphrase').value;
  if (passphrase.length < 12) { dialogMessage('Use a passphrase with at least 12 characters.'); input('backup-passphrase').focus(); return; }
  if (backupMode === 'backup' && passphrase !== input('backup-confirmation').value) {
    dialogMessage('Those passphrases do not match. Please try again.'); input('backup-confirmation').focus(); return;
  }
  const mode = backupMode;
  void action(mode, async () => {
    const result = await (mode === 'backup' ? api.backup(passphrase) : api.restore(passphrase));
    applyStatus(result.status);
    if (result.cancelled) { dialogMessage('No backup file was selected.', false); return; }
    closeDialog(backupDialog);
    notice(mode === 'backup' ? 'Your notes backup is saved.' : 'Your notes are restored. Welcome back.');
    if (mode === 'restore' && result.status.running) await loadNotes();
  }, '', () => {
    dialogMessage(mode === 'backup' ? 'Your backup could not be saved. Please try again.'
      : status?.restorePending ? 'Restore was interrupted. Choose the same backup to finish safely.'
        : 'Your notes could not be restored. Check your backup passphrase and try again.');
    input('backup-passphrase').focus();
  });
});

window.addEventListener('pagehide', () => { if (pollTimer) clearTimeout(pollTimer); });
controls();
void refreshStatus(true);
