/** Shipping HTML and the freshly bundled renderer; only IPC and the polling clock are scripted. */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import type { DesktopApi, LocalNote, PodStatus } from '../src/types.js';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..');
let bundle: string;
const documents: JSDOM[] = [];

beforeAll(async () => {
  const built = await build({
    entryPoints: [join(APP, 'src/renderer.ts')], bundle: true, format: 'iife',
    platform: 'browser', target: 'es2022', write: false, logLevel: 'silent',
  });
  bundle = built.outputFiles[0]!.text;
}, 60_000);
afterEach(() => { for (const document of documents.splice(0)) document.window.close(); });

const state = (value: PodStatus['state'], noteCount = 0): PodStatus => ({
  state: value, configured: value !== 'unconfigured', running: value === 'running',
  localOnly: true, federationEnabled: false, noteCount,
});
const note = (title = 'A note to keep', body = 'The exact words I want to remember.'): LocalNote => ({
  id: 'note-1', title, body, createdAt: '2026-10-29T12:00:00Z', updatedAt: '2026-10-29T12:00:00Z',
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
async function flush(): Promise<void> {
  for (let i = 0; i < 3; i++) await new Promise<void>(done => setImmediate(done));
}

async function mount(initial = state('unconfigured'), overrides: Partial<DesktopApi> = {}, initialNotes: readonly LocalNote[] = []) {
  let current = initial;
  let saved = [...initialNotes];
  const api: DesktopApi = {
    status: vi.fn(async () => current),
    setup: vi.fn(async () => { current = state('running', saved.length); return current; }),
    start: vi.fn(async () => { current = state('running', saved.length); return current; }),
    stop: vi.fn(async () => { current = state('stopped', saved.length); return current; }),
    notes: vi.fn(async () => saved),
    saveNote: vi.fn(async value => {
      const created = { ...note(value.title, value.body), id: `note-${saved.length + 1}` };
      saved = [...saved, created]; current = { ...current, noteCount: saved.length };
      return created;
    }),
    backup: vi.fn(async () => ({ cancelled: false, status: current })),
    restore: vi.fn(async () => { current = state('running', saved.length); return { cancelled: false, status: current }; }),
    openDataFolder: vi.fn(async () => undefined),
    openHosted: vi.fn(async () => undefined),
    ...overrides,
  };
  const dom = new JSDOM(readFileSync(join(APP, 'index.html'), 'utf8'), {
    url: 'file:///interego/index.html', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  documents.push(dom);
  const timers = new Map<number, () => void>();
  let timerId = 0;
  // Advance only the renderer's own polling turn, without wall-clock assertions.
  dom.window.setTimeout = ((handler: unknown) => {
    if (typeof handler !== 'function') throw new Error('Unexpected string timer');
    timers.set(++timerId, handler as () => void);
    return timerId;
  }) as typeof dom.window.setTimeout;
  dom.window.clearTimeout = ((id: number) => { timers.delete(id); }) as typeof dom.window.clearTimeout;
  Object.defineProperty(dom.window, 'interego', { value: api });
  dom.window.eval(bundle);
  await flush();
  const get = <T extends HTMLElement = HTMLElement>(id: string): T => dom.window.document.getElementById(id) as T;
  return {
    api, dom, get,
    click: (id: string) => get<HTMLButtonElement>(id).click(),
    submit: (id: string) => get(id).dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })),
    fill: (id: string, value: string) => { get<HTMLInputElement>(id).value = value; },
    setNotes: (value: readonly LocalNote[]) => { saved = [...value]; },
    setStatus: (value: PodStatus) => { current = value; },
    poll: async () => {
      const scheduled = [...timers.entries()].pop();
      if (!scheduled) throw new Error('No renderer poll was scheduled');
      timers.delete(scheduled[0]); scheduled[1](); await flush();
    },
  };
}

describe('Interego consumer desktop', () => {
  it('offers local setup and hosted use explicitly without starting either automatically', async () => {
    const app = await mount();
    expect(app.get('welcome').hidden).toBe(false);
    expect(app.get('shell').hidden).toBe(true);
    expect(app.get('welcome').textContent).toContain('Your memory.On your computer.');
    expect(app.get('setup-local').textContent).toContain('Set up on this computer');
    expect(app.api.setup).not.toHaveBeenCalled();
    expect(app.api.notes).not.toHaveBeenCalled();
    expect(app.api.openHosted).not.toHaveBeenCalled();
    app.click('welcome-hosted'); await flush();
    expect(app.api.openHosted).toHaveBeenCalledTimes(1);
    expect(app.api.setup).not.toHaveBeenCalled();
  });

  it('keeps setup pending until the actual setup result and prevents repeated setup', async () => {
    const setup = deferred<PodStatus>();
    const app = await mount(state('unconfigured'), { setup: vi.fn(() => setup.promise) });
    app.click('setup-local'); app.click('setup-local');
    expect(app.api.setup).toHaveBeenCalledTimes(1);
    expect(app.get<HTMLButtonElement>('setup-local').disabled).toBe(true);
    expect(app.get('setup-progress').hidden).toBe(false);
    expect(app.get('welcome').hidden).toBe(false);
    setup.resolve(state('running')); await flush();
    expect(app.get('shell').hidden).toBe(false);
    expect(app.get('status-label').textContent).toBe('Ready on this computer');
    expect(app.api.notes).toHaveBeenCalledTimes(1);
    expect(app.get('notes-empty').textContent).toContain('Save your first note');
  });

  it('shows setup failure without inventing a configured space or discarding recovery choices', async () => {
    const app = await mount(state('unconfigured'), { setup: vi.fn(async () => { throw new Error('Storage could not be opened'); }) });
    app.click('setup-local'); await flush();
    expect(app.get('welcome').hidden).toBe(false);
    expect(app.get('shell').hidden).toBe(true);
    expect(app.get('notice').getAttribute('role')).toBe('alert');
    expect(app.get('notice-message').textContent).toContain('could not be set up');
    expect(app.get<HTMLButtonElement>('setup-local').disabled).toBe(false);
    expect(app.get<HTMLButtonElement>('welcome-restore').disabled).toBe(false);
  });

  it('offers start retry when a failed setup actually left the space configured', async () => {
    const app: Awaited<ReturnType<typeof mount>> = await mount(state('unconfigured'), { setup: vi.fn(async () => {
      app.setStatus(state('error'));
      throw new Error('The configured space could not start');
    }) });
    app.click('setup-local'); await flush();
    expect(app.get('welcome').hidden).toBe(true);
    expect(app.get('shell').hidden).toBe(false);
    expect(app.get('toggle-running').textContent).toBe('Try again');
    app.click('toggle-running'); await flush();
    expect(app.api.start).toHaveBeenCalledTimes(1);
    expect(app.api.setup).toHaveBeenCalledTimes(1);
  });

  it('renders saved user text literally and opens the complete note safely', async () => {
    const text = '<img src=x onerror="window.bad=true">';
    const app = await mount(state('running', 1), {}, [note(text, `${text}\n${'More words. '.repeat(40)}`)]);
    expect(app.get('notes-list').textContent).toContain(text);
    expect(app.get('notes-list').querySelector('img')).toBeNull();
    app.get('notes-list').querySelector<HTMLButtonElement>('button')!.click();
    expect(app.get<HTMLDialogElement>('note-dialog').open).toBe(true);
    expect(app.get('read-note-body').textContent).toBe(`${text}\n${'More words. '.repeat(40)}`);
    expect(app.get('read-note-body').querySelector('img')).toBeNull();
    app.click('close-note');
    expect(app.get<HTMLDialogElement>('note-dialog').open).toBe(false);
    expect(app.get('read-note-body').textContent).toBe('');
  });

  it('saves the supplied note through IPC, refreshes actual notes and clears the completed draft', async () => {
    const app = await mount(state('running'));
    app.fill('note-title', '  A decision  '); app.fill('note-body', 'Keep every word.\nAnd this line.');
    app.submit('note-form'); await flush();
    expect(app.api.saveNote).toHaveBeenCalledWith({ title: 'A decision', body: 'Keep every word.\nAnd this line.' });
    expect(app.get('notes-list').textContent).toContain('A decision');
    expect(app.get('notes-list').textContent).toContain('Keep every word.');
    expect(app.get<HTMLInputElement>('note-title').value).toBe('');
    expect(app.get<HTMLTextAreaElement>('note-body').value).toBe('');
    expect(app.get('notice-message').textContent).toBe('Your note is saved.');
  });

  it('does not show success while saving and preserves the draft when saving fails', async () => {
    const save = deferred<LocalNote>();
    const app = await mount(state('running'), { saveNote: vi.fn(() => save.promise) });
    app.fill('note-title', 'My draft'); app.fill('note-body', 'Please keep this draft.');
    app.submit('note-form');
    expect(app.get<HTMLButtonElement>('save-note').disabled).toBe(true);
    expect(app.get('notice').hidden).toBe(true);
    save.reject(new Error('<script>unsafe()</script>')); await flush();
    expect(app.get<HTMLInputElement>('note-title').value).toBe('My draft');
    expect(app.get<HTMLTextAreaElement>('note-body').value).toBe('Please keep this draft.');
    expect(app.get('notice-message').textContent).toContain('Your draft is still here');
    expect(app.get('notice-detail-text').querySelector('script')).toBeNull();
    expect(app.get<HTMLButtonElement>('save-note').disabled).toBe(false);
  });

  it('ignores a note read that finishes after the user has stopped the local space', async () => {
    const reading = deferred<readonly LocalNote[]>();
    const app = await mount(state('running', 1), { notes: vi.fn(() => reading.promise) });
    app.click('toggle-running'); await flush();
    expect(app.api.stop).toHaveBeenCalledTimes(1);
    expect(app.get('status-label').textContent).toBe('Resting on this computer');
    reading.resolve([note('Old result', 'This must not reappear.')]); await flush();
    expect(app.get('notes-list').textContent).not.toContain('This must not reappear.');
    expect(app.get<HTMLButtonElement>('save-note').disabled).toBe(true);
    expect(app.get('empty-description').textContent).toContain('Start Interego');
  });

  it('shows real transition and error states with an appropriate retry action', async () => {
    const app = await mount(state('starting'));
    expect(app.get('status-label').textContent).toContain('Getting your space ready');
    expect(app.get<HTMLButtonElement>('toggle-running').disabled).toBe(true);
    app.setStatus({ ...state('error'), lastError: 'Start failed' }); await app.poll();
    expect(app.get('status-label').textContent).toBe('Your space needs a moment');
    expect(app.get('toggle-running').textContent).toBe('Try again');
    app.click('toggle-running'); await flush();
    expect(app.api.start).toHaveBeenCalledTimes(1);
    expect(app.get('status-label').textContent).toBe('Ready on this computer');
  });

  it('keeps Stop as the action when the pod is still running after a failed operation', async () => {
    const app = await mount({ ...state('error', 1), running: true, lastError: 'A note could not be read' });
    expect(app.get('status-label').textContent).toBe('Running on this computer');
    expect(app.get('status-description').textContent).not.toContain('could not start');
    expect(app.get('toggle-running').textContent).toBe('Stop Interego');
    app.click('toggle-running'); await flush();
    expect(app.api.stop).toHaveBeenCalledTimes(1);
    expect(app.api.start).not.toHaveBeenCalled();
  });

  it('shows an unknown count until notes have actually been read', async () => {
    const reading = deferred<readonly LocalNote[]>();
    const app = await mount(state('running', 9), { notes: vi.fn(() => reading.promise) });
    expect(app.get('note-count').textContent).toBe('—');
    reading.resolve([note()]); await flush();
    expect(app.get('note-count').textContent).toBe('1');
    app.setStatus(state('stopped', 9)); await app.poll();
    expect(app.get('note-count').textContent).toBe('—');
  });

  it('reports a failed initial status check and lets the user retry without running setup', async () => {
    const check = vi.fn<DesktopApi['status']>().mockRejectedValueOnce(new Error('Unavailable')).mockResolvedValue(state('unconfigured'));
    const app = await mount(state('unconfigured'), { status: check });
    expect(app.get('loading-message').textContent).toContain('could not be opened');
    expect(app.get<HTMLButtonElement>('retry-load').hidden).toBe(false);
    expect(app.get('welcome').hidden).toBe(true);
    app.click('retry-load'); await flush();
    expect(app.get('welcome').hidden).toBe(false);
    expect(app.get('notice').hidden).toBe(true);
    expect(app.api.setup).not.toHaveBeenCalled();
  });

  it('clears a failed note-read notice after a successful retry', async () => {
    const read = vi.fn<DesktopApi['notes']>()
      .mockRejectedValueOnce(new Error('Read interrupted')).mockResolvedValue([note('Read after retry')]);
    const app = await mount(state('running'), { notes: read });
    expect(app.get('notice-message').textContent).toContain('could not be read');
    expect(app.get('note-count').textContent).toBe('—');
    app.click('retry-notes'); await flush();
    expect(app.get('notes-list').textContent).toContain('Read after retry');
    expect(app.get('notice').hidden).toBe(true);
    expect(app.get('note-count').textContent).toBe('1');
  });

  it('keeps an unrelated completed-action notice when status polling succeeds', async () => {
    const app = await mount(state('running'));
    app.fill('note-title', 'Remember this'); app.fill('note-body', 'A saved thought.');
    app.submit('note-form'); await flush();
    expect(app.get('notice-message').textContent).toBe('Your note is saved.');
    await app.poll();
    expect(app.get('notice').hidden).toBe(false);
    expect(app.get('notice-message').textContent).toBe('Your note is saved.');
  });

  it('surfaces unreadable existing settings even when no configured profile can be established', async () => {
    const failure: PodStatus = { ...state('error'), configured: false, lastError: 'Your settings could not be read.' };
    const app = await mount(failure);
    expect(app.get('welcome').hidden).toBe(false);
    expect(app.get('notice').getAttribute('role')).toBe('alert');
    expect(app.get('notice-message').textContent).toContain('kept unchanged');
    expect(app.get('notice-detail-text').textContent).toBe('Your settings could not be read.');
    expect(app.api.setup).not.toHaveBeenCalled();
    app.click('dismiss-notice'); await app.poll();
    expect(app.get('notice').hidden).toBe(true);
    app.setStatus({ ...failure, lastError: 'The settings problem has changed.' }); await app.poll();
    expect(app.get('notice').hidden).toBe(false);
    expect(app.get('notice-detail-text').textContent).toBe('The settings problem has changed.');
    app.setStatus(state('unconfigured')); await app.poll();
    expect(app.get('notice').hidden).toBe(true);
  });

  it('requires matching backup passphrases and never calls export for invalid input', async () => {
    const app = await mount(state('running'));
    app.click('nav-backup'); app.click('backup-notes');
    expect(app.get<HTMLDialogElement>('backup-dialog').open).toBe(true);
    expect(app.dom.window.document.activeElement?.id).toBe('backup-passphrase');
    app.fill('backup-passphrase', 'short'); app.fill('backup-confirmation', 'short');
    app.submit('backup-form'); await flush();
    expect(app.api.backup).not.toHaveBeenCalled();
    expect(app.get('backup-dialog-error').textContent).toContain('at least 12');
    app.fill('backup-passphrase', 'a long backup phrase'); app.fill('backup-confirmation', 'a different long phrase');
    app.submit('backup-form'); await flush();
    expect(app.api.backup).not.toHaveBeenCalled();
    expect(app.get('backup-dialog-error').textContent).toContain('do not match');
  });

  it('treats a cancelled save dialog as cancellation and keeps success hidden', async () => {
    const app = await mount(state('running'), { backup: vi.fn(async () => ({ cancelled: true, status: state('running') })) });
    app.click('nav-backup'); app.click('backup-notes');
    app.fill('backup-passphrase', 'a long backup phrase'); app.fill('backup-confirmation', 'a long backup phrase');
    app.submit('backup-form'); await flush();
    expect(app.api.backup).toHaveBeenCalledWith('a long backup phrase');
    expect(app.get<HTMLDialogElement>('backup-dialog').open).toBe(true);
    expect(app.get('backup-dialog-error').textContent).toBe('No backup file was selected.');
    expect(app.get('notice').hidden).toBe(true);
  });

  it('shows completed backup only after success and clears the passphrase on close', async () => {
    const backup = deferred<Awaited<ReturnType<DesktopApi['backup']>>>();
    const app = await mount(state('running'), { backup: vi.fn(() => backup.promise) });
    app.click('nav-backup'); app.click('backup-notes');
    app.fill('backup-passphrase', 'a long backup phrase'); app.fill('backup-confirmation', 'a long backup phrase');
    app.submit('backup-form');
    expect(app.get<HTMLButtonElement>('confirm-backup').disabled).toBe(true);
    expect(app.get('notice').hidden).toBe(true);
    backup.resolve({ cancelled: false, status: state('running') }); await flush();
    expect(app.get<HTMLDialogElement>('backup-dialog').open).toBe(false);
    expect(app.get<HTMLInputElement>('backup-passphrase').value).toBe('');
    expect(app.get<HTMLInputElement>('backup-confirmation').value).toBe('');
    expect(app.get('notice-message').textContent).toBe('Your notes backup is saved.');
  });

  it('offers restore on a new space, preserving that choice when a passphrase fails', async () => {
    const app = await mount(state('unconfigured'), { restore: vi.fn(async () => { throw new Error('Wrong passphrase'); }) });
    app.click('welcome-restore');
    expect(app.get('confirmation-field').hidden).toBe(true);
    app.fill('backup-passphrase', 'a long backup phrase'); app.submit('backup-form'); await flush();
    expect(app.api.restore).toHaveBeenCalledWith('a long backup phrase');
    expect(app.get('backup-dialog-error').textContent).toContain('Check your backup passphrase');
    expect(app.get('welcome').hidden).toBe(false);
    expect(app.get('shell').hidden).toBe(true);
  });

  it('draws restored notes from the returned configured space and refuses restore into an existing space', async () => {
    const app = await mount(state('unconfigured'), {}, [note('Restored thought')]);
    app.click('welcome-restore'); app.fill('backup-passphrase', 'a long backup phrase'); app.submit('backup-form'); await flush();
    expect(app.get('shell').hidden).toBe(false);
    expect(app.get('notes-list').textContent).toContain('Restored thought');
    expect(app.get('notice-message').textContent).toContain('Your notes are restored');
    app.click('welcome-restore');
    expect(app.get<HTMLDialogElement>('backup-dialog').open).toBe(false);
    expect(app.api.restore).toHaveBeenCalledTimes(1);
  });

  it('offers a safe finish-restore action for an interrupted restore instead of trying to start', async () => {
    const app = await mount({ ...state('error'), restorePending: true });
    expect(app.get('status-label').textContent).toBe('Finish restoring your notes');
    expect(app.get('toggle-running').textContent).toBe('Finish restore');
    app.click('toggle-running');
    expect(app.get<HTMLDialogElement>('backup-dialog').open).toBe(true);
    expect(app.get('backup-dialog-description').textContent).toContain('Choose the same backup');
    expect(app.api.start).not.toHaveBeenCalled();
    app.fill('backup-passphrase', 'a long backup phrase'); app.submit('backup-form'); await flush();
    expect(app.api.restore).toHaveBeenCalledTimes(1);
  });

  it('routes folder and hosted actions explicitly and keeps the local privacy state visible', async () => {
    const app = await mount(state('running'));
    app.click('nav-settings');
    expect(app.get('settings-page').hidden).toBe(false);
    expect(app.get('settings-page').textContent).toContain('Sharing & federation');
    expect(app.dom.window.document.querySelector('.privacy-pill')?.textContent).toContain('Sharing is off');
    app.click('open-folder'); await flush(); app.click('open-hosted'); await flush();
    expect(app.api.openDataFolder).toHaveBeenCalledTimes(1);
    expect(app.api.openHosted).toHaveBeenCalledTimes(1);
    expect(app.api.setup).not.toHaveBeenCalled();
  });
});
