import type { DesktopApi, LocalNote, PodStatus } from './types.js';

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
let status: PodStatus | null = null;
let notes: readonly LocalNote[] = [];
let notesLoaded = false;
let notesError = false;
let busy: string | null = null;
type Page = 'memory' | 'backup' | 'settings';
let backupMode: 'backup' | 'restore' = 'backup';
let statusRequest = 0;
let noteRequest = 0;
let stateEpoch = 0;
let pollTimer: ReturnType<typeof setTimeout> | undefined;
let previousFocus: HTMLElement | null = null;
let pendingFocus: HTMLElement | null = null;
type NoticeSource = 'action' | 'status' | 'notes' | 'profile';
let noticeSource: NoticeSource | null = null;
let profileErrorSignature: string | null = null;

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
      item.addEventListener('click', () => {
        element('read-note-title').textContent = note.title;
        element('read-note-body').textContent = note.body;
        element('read-note-date').textContent = `Saved ${dateLabel(note.updatedAt, true)}`;
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
  for (const id of ['setup-local', 'welcome-hosted', 'welcome-restore', 'open-hosted']) button(id).disabled = occupied;
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
  document.body.setAttribute('aria-busy', String(occupied));
}

function applyStatus(next: PodStatus): void {
  const wasRunning = !!status?.running;
  if (status?.state !== next.state || status?.configured !== next.configured) stateEpoch++;
  status = next;
  element('loading-screen').hidden = true;
  element('welcome').hidden = next.configured;
  element('shell').hidden = !next.configured;
  const descriptions: Record<PodStatus['state'], [string, string]> = {
    unconfigured: ['Your private space is ready to begin', 'Saved on this computer. Sharing is off.'],
    stopped: ['Resting on this computer', 'Your saved notes are safe here. Start when you are ready.'],
    starting: ['Getting your space ready…', 'Your local space is starting.'],
    running: ['Ready on this computer', 'Your saved notes are encrypted. Sharing is off.'],
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
  if (busy) { schedulePoll(); return; }
  const requested = ++statusRequest;
  try {
    if (!api) throw new Error('Open the installed Interego application to use your local space.');
    const next = await api.status();
    if (requested === statusRequest) { clearNotice('status'); applyStatus(next); }
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
    else if (['setup', 'restore', 'save'].includes(name) && status?.running && !element('memory-page').hidden) input('note-title').focus();
    pendingFocus = null;
    schedulePoll();
  }
}

function selectPage(next: Page): void {
  const headings = {
    memory: ['Your memory', 'A little space for what matters.'],
    backup: ['Backup & recovery', 'Keep a safe copy of your saved notes.'],
    settings: ['Your space, your way', 'A few things to make yourself at home.'],
  };
  element('page-title').textContent = headings[next][0]!;
  element('page-description').textContent = headings[next][1]!;
  for (const name of ['memory', 'backup', 'settings'] as const) {
    element(`${name}-page`).hidden = next !== name;
    if (name === next) button(`nav-${name}`).setAttribute('aria-current', 'page');
    else button(`nav-${name}`).removeAttribute('aria-current');
  }
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
for (const name of ['memory', 'backup', 'settings'] as const) button(`nav-${name}`).addEventListener('click', () => selectPage(name));
for (const id of ['welcome-hosted', 'open-hosted']) button(id).addEventListener('click', () => {
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
