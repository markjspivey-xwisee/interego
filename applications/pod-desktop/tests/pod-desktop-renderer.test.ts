/** Shipping HTML and the freshly bundled renderer; only IPC and the polling clock are scripted. */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import type { DesktopApi, LocalNote, PodStatus } from '../src/types.js';
import type { AgentConnection, AgentSetup } from '../src/agent-types.js';
import type { BridgeStatus, StableBridgeView } from '../src/bridge-types.js';

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
const connection = (id = 'connection-1', value: AgentConnection['state'] = 'waiting'): AgentConnection => ({
  id, name: id === 'connection-1' ? 'My AI app' : 'Another app', client: 'codex', permissions: ['notes:read'],
  createdAt: '2026-10-29T12:00:00Z', expiresAt: '2026-11-28T12:00:00Z', state: value,
});
const connectionSetup = (id = 'connection-1'): AgentSetup => ({
  connectionId: id, title: 'Set up your app', configLocation: 'Your app settings',
  steps: ['Add this local connection in your app.'], configuration: '{"command":"Interego.exe","args":["--agent"]}',
  command: 'Interego.exe --agent',
});
const webReady = (): BridgeStatus => ({ state: 'ready', client: 'chatgpt-web', name: 'My web assistant',
  url: 'https://sample.trycloudflare.com/mcp', permissions: ['notes:read'], expiresInDays: 30, pendingApprovals: [], connections: [] });
const webRequest = () => ({ id: 'request-1', clientName: 'ChatGPT', redirectOrigin: 'https://chatgpt.com',
  permissions: ['notes:read'] as const, createdAt: '2026-10-29T12:00:00Z', expiresAt: '2026-10-29T12:10:00Z', verificationCode: '1234-5678' });
const stableView = (): StableBridgeView => ({ provider: 'cloudflare', origin: 'https://memory.example.com', port: 49111, hasCredential: true,
  policy: { client: 'chatgpt-web', name: 'My web assistant', permissions: ['notes:read'], expiresInDays: 30 } });
const webPaused = (settings = stableView(), connections: BridgeStatus['connections'] = []): BridgeStatus => ({
  state: 'off', mode: 'stable', remembered: true, url: `${settings.origin}/mcp`, client: settings.policy.client,
  name: settings.policy.name, permissions: settings.policy.permissions, expiresInDays: settings.policy.expiresInDays, pendingApprovals: [], connections,
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

async function mount(initial = state('unconfigured'), overrides: Partial<DesktopApi> = {}, initialNotes: readonly LocalNote[] = [], initialConnections: readonly AgentConnection[] = [], initialStable: StableBridgeView | null = null) {
  let current = initial;
  let saved = [...initialNotes];
  let grants = [...initialConnections];
  let stableSettings = initialStable;
  let bridge: BridgeStatus = initialStable ? webPaused(initialStable) : { state: 'off', permissions: [], pendingApprovals: [], connections: [] };
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
    connections: vi.fn(async () => grants),
    createConnection: vi.fn(async value => {
      const created: AgentConnection = {
        ...value, id: `connection-${grants.length + 1}`, state: 'waiting',
        createdAt: '2026-10-29T12:00:00Z', expiresAt: '2026-11-28T12:00:00Z',
      };
      grants = [...grants, created]; return created;
    }),
    revokeConnection: vi.fn(async id => {
      grants = grants.map(grant => grant.id === id ? { ...grant, state: 'revoked' } : grant);
      bridge = { ...bridge, connections: bridge.connections.map(grant => grant.id === id ? { ...grant, state: 'revoked' } : grant) };
    }),
    connectionSetup: vi.fn(async id => connectionSetup(id)),
    copyConnectionSetup: vi.fn(async () => undefined),
    bridgeStatus: vi.fn(async () => bridge),
    startBridge: vi.fn(async value => {
      bridge = { state: 'ready', url: 'https://sample.trycloudflare.com/mcp', client: value.client, name: value.name,
        permissions: value.permissions, expiresInDays: value.expiresInDays, pendingApprovals: [], connections: [] };
      return bridge;
    }),
    stopBridge: vi.fn(async () => { bridge = stableSettings ? { ...webPaused(stableSettings, bridge.connections) } : { state: 'off', permissions: [], pendingApprovals: [], connections: [] }; return bridge; }),
    approveBridge: vi.fn(async id => {
      const pending = bridge.pendingApprovals.find(value => value.id === id);
      const grant = { ...connection('web-connection-1'), client: 'other' as const, name: bridge.name ?? 'Web assistant', permissions: pending?.permissions ?? [] };
      bridge = { ...bridge, pendingApprovals: bridge.pendingApprovals.filter(value => value.id !== id), connections: [...bridge.connections, grant] };
      grants = [...grants, grant]; return bridge;
    }),
    denyBridge: vi.fn(async id => { bridge = { ...bridge, pendingApprovals: bridge.pendingApprovals.filter(value => value.id !== id) }; return bridge; }),
    copyBridgeUrl: vi.fn(async () => undefined),
    openBridgeClient: vi.fn(async () => undefined),
    stableBridgeSettings: vi.fn(async () => stableSettings),
    saveStableBridge: vi.fn(async value => {
      stableSettings = { provider: value.provider, origin: value.origin, port: 49111, hasCredential: value.provider === 'cloudflare', policy: value.policy };
      bridge = webPaused(stableSettings);
      return stableSettings;
    }),
    resumeBridge: vi.fn(async () => {
      if (!stableSettings) throw new Error('No saved address');
      bridge = { ...webPaused(stableSettings, bridge.connections), state: 'ready' }; return bridge;
    }),
    forgetStableBridge: vi.fn(async () => {
      const ids = bridge.connections.map(value => value.id);
      grants = grants.map(value => ids.includes(value.id) ? { ...value, state: 'revoked' } : value);
      stableSettings = null; bridge = { state: 'off', permissions: [], pendingApprovals: [], connections: [] }; return bridge;
    }),
    copyStableBridgeTarget: vi.fn(async () => undefined),
    openStableBridgeSetup: vi.fn(async () => undefined),
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
    setConnections: (value: readonly AgentConnection[]) => { grants = [...value]; },
    setBridge: (value: BridgeStatus) => { bridge = value; },
    setStable: (value: StableBridgeView | null) => { stableSettings = value; },
    temporary: () => { get<HTMLSelectElement>('bridge-address-mode').value = 'temporary'; get('bridge-address-mode').dispatchEvent(new dom.window.Event('change')); },
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
    expect(app.get('settings-page').textContent).toContain('Pod-to-pod sharing');
    expect(app.dom.window.document.querySelector('.privacy-pill')?.textContent).toContain('Federation off');
    app.click('open-folder'); await flush(); app.click('open-hosted'); await flush();
    expect(app.api.openDataFolder).toHaveBeenCalledTimes(1);
    expect(app.api.openHosted).toHaveBeenCalledTimes(1);
    expect(app.api.setup).not.toHaveBeenCalled();
  });

  it('creates an explicitly chosen local connection with read-only access and a 30-day default', async () => {
    const app = await mount(state('running'));
    app.click('nav-connections'); await flush(); app.click('add-connection');
    expect(app.get<HTMLDialogElement>('connection-dialog').open).toBe(true);
    expect(Array.from(app.get<HTMLSelectElement>('connection-client').options).map(option => option.value)).toEqual([
      'chatgpt-desktop', 'codex', 'claude-code', 'claude-desktop', 'grok-build', 'openclaw', 'other',
    ]);
    expect(app.get<HTMLInputElement>('permission-read').checked).toBe(true);
    expect(app.get<HTMLInputElement>('permission-create').checked).toBe(false);
    expect(app.get<HTMLSelectElement>('connection-expiry').value).toBe('30');
    expect(app.get('connection-consent').textContent).toContain('online AI service');
    app.fill('connection-name', 'My desktop assistant'); app.submit('connection-form'); await flush();
    expect(app.api.createConnection).toHaveBeenCalledWith({ name: 'My desktop assistant', client: 'chatgpt-desktop', permissions: ['notes:read'], expiresInDays: 30 });
    expect(app.get('connection-setup-state').textContent).toBe('Waiting for first use');
    expect(app.get('connections-list').textContent).toContain('Waiting for first use');
    expect(app.get('connection-form').hidden).toBe(true);
    expect(app.api.openHosted).not.toHaveBeenCalled();
  });

  it('preserves connection choices across polls and validates permissions before creating', async () => {
    const app = await mount(state('running'));
    app.click('nav-connections'); await flush(); app.click('add-connection');
    app.fill('connection-name', 'A custom name');
    app.fill('connection-client', 'openclaw');
    app.get('connection-client').dispatchEvent(new app.dom.window.Event('change'));
    expect(app.get<HTMLInputElement>('connection-name').value).toBe('A custom name');
    app.get<HTMLInputElement>('permission-read').checked = false;
    app.get('permission-read').dispatchEvent(new app.dom.window.Event('change'));
    expect(app.get<HTMLButtonElement>('create-connection').disabled).toBe(true);
    app.submit('connection-form'); await flush();
    expect(app.api.createConnection).not.toHaveBeenCalled();
    app.get<HTMLInputElement>('permission-create').checked = true;
    app.get('permission-create').dispatchEvent(new app.dom.window.Event('change'));
    app.fill('connection-expiry', '7'); await app.poll();
    expect(app.get<HTMLInputElement>('connection-name').value).toBe('A custom name');
    expect(app.get<HTMLSelectElement>('connection-expiry').value).toBe('7');
    expect(app.get('connection-consent').textContent).toContain('not be allowed to read');
    app.submit('connection-form'); await flush();
    expect(app.api.createConnection).toHaveBeenCalledWith({ name: 'A custom name', client: 'openclaw', permissions: ['notes:create'], expiresInDays: 7 });
  });

  it('copies setup for the existing grant without manufacturing a successful connection', async () => {
    const app = await mount(state('running'));
    app.click('nav-connections'); await flush(); app.click('add-connection'); app.submit('connection-form'); await flush();
    expect(app.get('copy-connection-command').textContent).toBe('Copy PowerShell command');
    app.click('copy-connection-config'); await flush(); app.click('copy-connection-command'); await flush();
    expect(app.api.copyConnectionSetup).toHaveBeenNthCalledWith(1, 'connection-1', 'configuration');
    expect(app.api.copyConnectionSetup).toHaveBeenNthCalledWith(2, 'connection-1', 'command');
    expect(app.api.createConnection).toHaveBeenCalledTimes(1);
    expect(app.get('connection-setup-state').textContent).toBe('Waiting for first use');
    expect(app.get('connection-message').textContent).toContain('Setup copied');
    app.setConnections([{ ...connection(), state: 'active', lastUsedAt: '2026-10-29T12:15:00Z' }]); await app.poll();
    expect(app.get('connection-setup-state').textContent).toBe('Access allowed');
    expect(app.get('connection-setup-help').textContent).toContain('Last used');
  });

  it('retries setup loading for the same saved grant and handles clipboard failure honestly', async () => {
    const setupRead = vi.fn<DesktopApi['connectionSetup']>().mockRejectedValueOnce(new Error('Unavailable')).mockResolvedValue(connectionSetup());
    const app = await mount(state('running'), {
      connectionSetup: setupRead, copyConnectionSetup: vi.fn(async () => { throw new Error('Clipboard unavailable'); }),
    });
    app.click('nav-connections'); await flush(); app.click('add-connection'); app.submit('connection-form'); await flush();
    expect(app.get('connection-message').textContent).toContain('setup could not be loaded');
    expect(app.get<HTMLButtonElement>('copy-connection-config').disabled).toBe(true);
    app.click('retry-connection-setup'); await flush();
    expect(app.api.createConnection).toHaveBeenCalledTimes(1);
    expect(setupRead).toHaveBeenNthCalledWith(2, 'connection-1');
    expect(app.get<HTMLButtonElement>('copy-connection-config').disabled).toBe(false);
    app.click('copy-connection-config'); await flush();
    expect(app.get('connection-message').textContent).toContain('could not be copied');
    expect(app.get('connection-message').textContent).not.toContain('Setup copied');
  });

  it('shows unavailable connections on read failure, then displays the authoritative retry', async () => {
    const read = vi.fn<DesktopApi['connections']>().mockRejectedValueOnce(new Error('Read failed')).mockResolvedValue([connection()]);
    const app = await mount(state('running'), { connections: read });
    app.click('nav-connections'); await flush();
    expect(app.get('connections-empty-title').textContent).toBe('Connections could not be checked');
    expect(app.get('connections-empty-description').textContent).not.toContain('No apps');
    app.click('refresh-connections'); await flush();
    expect(app.get('connections-list').textContent).toContain('My AI app');
    expect(app.get('connections-empty').hidden).toBe(true);
    expect(app.get('notice').hidden).toBe(true);
  });

  it('allows connection management while stopped and waits for revocation before changing its state', async () => {
    const revoking = deferred<void>();
    const app = await mount(state('stopped'), { revokeConnection: vi.fn(() => revoking.promise) }, [], [connection(), connection('connection-2', 'active')]);
    app.click('nav-connections'); await flush();
    expect(app.get<HTMLButtonElement>('add-connection').disabled).toBe(false);
    const target = app.get('connections-list').querySelector<HTMLElement>('[data-connection-id="connection-1"]')!;
    target.querySelector<HTMLButtonElement>('.danger')!.click();
    expect(app.api.revokeConnection).toHaveBeenCalledWith('connection-1');
    expect(target.textContent).toContain('Waiting for first use');
    app.setConnections([{ ...connection(), state: 'revoked' }, connection('connection-2', 'active')]);
    revoking.resolve(); await flush();
    expect(app.get('connections-list').querySelector('[data-connection-id="connection-1"]')?.textContent).toContain('Disconnected');
    expect(app.get('connections-list').querySelector('[data-connection-id="connection-2"]')?.textContent).toContain('Access allowed');
    expect(app.api.start).not.toHaveBeenCalled();
  });

  it('does not let a stale list response restore access after revocation', async () => {
    const stale = deferred<readonly AgentConnection[]>();
    const read = vi.fn<DesktopApi['connections']>()
      .mockResolvedValueOnce([connection()]).mockImplementationOnce(() => stale.promise)
      .mockResolvedValue([{ ...connection(), state: 'revoked' }]);
    const app = await mount(state('running'), { connections: read });
    app.click('nav-connections'); await flush(); app.click('refresh-connections');
    app.get('connections-list').querySelector<HTMLButtonElement>('.danger')!.click(); await flush();
    expect(app.get('connections-list').textContent).toContain('Disconnected');
    stale.resolve([connection()]); await flush();
    expect(app.get('connections-list').textContent).toContain('Disconnected');
    expect(app.get('connections-list').querySelector('.danger')).toBeNull();
  });

  it('keeps actual access visible when revocation fails, without claiming disconnection', async () => {
    const app = await mount(state('running'), { revokeConnection: vi.fn(async () => { throw new Error('Not saved'); }) }, [], [connection()]);
    app.click('nav-connections'); await flush(); app.get('connections-list').querySelector<HTMLButtonElement>('.danger')!.click(); await flush();
    expect(app.get('connections-list').textContent).toContain('Waiting for first use');
    expect(app.get('notice-message').textContent).toContain('could not be confirmed');
    expect(app.get<HTMLButtonElement>('add-connection').disabled).toBe(false);
  });

  it('disables setup for revoked, expired, or changed-pod connections and for interrupted restores', async () => {
    const app = await mount({ ...state('error'), restorePending: true }, {}, [], [
      connection('revoked', 'revoked'), connection('expired', 'expired'), connection('changed', 'pod-changed'),
    ]);
    app.click('nav-connections'); await flush();
    expect(app.get('connections-list').textContent).toContain('Disconnected');
    expect(app.get('connections-list').textContent).toContain('Expired');
    expect(app.get('connections-list').textContent).toContain('Different space');
    expect(app.get('connections-list').querySelector('button')).toBeNull();
    expect(app.get<HTMLButtonElement>('add-connection').disabled).toBe(true);
    app.click('add-connection');
    expect(app.get<HTMLDialogElement>('connection-dialog').open).toBe(false);
  });

  it('ignores setup arriving after its dialog is closed and renders configuration literally', async () => {
    const pendingSetup = deferred<AgentSetup>();
    const app = await mount(state('running'), { connectionSetup: vi.fn(() => pendingSetup.promise) }, [], [connection()]);
    app.click('nav-connections'); await flush(); app.get('connections-list').querySelector<HTMLButtonElement>('.secondary')!.click();
    app.click('close-connection');
    pendingSetup.resolve({ ...connectionSetup(), configuration: '<img src=x onerror="bad()">' }); await flush();
    expect(app.get('connection-setup-configuration').textContent).toBe('');
    expect(app.get<HTMLDialogElement>('connection-dialog').open).toBe(false);
    app.get('connections-list').querySelector<HTMLButtonElement>('.secondary')!.click(); await flush();
    expect(app.get('connection-setup-configuration').textContent).toContain('<img');
    expect(app.get('connection-setup-configuration').querySelector('img')).toBeNull();
  });

  it('offers hosted use separately without creating a local grant or enabling federation', async () => {
    const app = await mount(state('running'));
    app.click('nav-connections'); await flush();
    expect(app.get('connections-page').textContent).toContain('cloud-hosted bots');
    app.click('connections-hosted'); await flush();
    expect(app.api.openHosted).toHaveBeenCalledTimes(1);
    expect(app.api.createConnection).not.toHaveBeenCalled();
    expect(app.dom.window.document.querySelector('.privacy-pill')?.textContent).toContain('Federation off');
  });

  it('shows agent-authored note labels literally without claiming a verified vendor identity', async () => {
    const authored = { ...note(), author: { connectionId: 'connection-1', name: '<img src=x> My assistant' } };
    const app = await mount(state('running', 1), {}, [authored]);
    expect(app.get('notes-list').textContent).toContain('Saved by <img src=x> My assistant');
    expect(app.get('notes-list').querySelector('img')).toBeNull();
    expect(app.get('notes-list').textContent).not.toContain('Verified');
    app.get('notes-list').querySelector<HTMLButtonElement>('.note-item')!.click();
    expect(app.get('read-note-date').textContent).toContain('Saved by <img src=x> My assistant');
  });
});

describe('optional web bridge owner controls', () => {
  it('defaults to a user-owned address while keeping temporary and hosted alternatives', async () => {
    const app = await mount(state('running'));
    app.click('nav-connections'); await flush(); app.click('start-bridge');
    expect(app.get<HTMLSelectElement>('bridge-address-mode').value).toBe('cloudflare');
    expect(app.get<HTMLInputElement>('bridge-token').type).toBe('password');
    expect(app.get('bridge-provider-help').textContent).toContain('your own Cloudflare account');
    expect(app.get('bridge-provider-help').textContent).toContain('without running the command');
    expect(app.get('bridge-dialog').textContent).toContain('Federation stays off');
    expect(app.get('bridge-address-mode').textContent).toContain('existing HTTPS gateway');
    expect(app.get('bridge-address-mode').textContent).toContain('temporary address');
    expect(app.api.resumeBridge).not.toHaveBeenCalled();
    expect(app.api.startBridge).not.toHaveBeenCalled();
    expect(app.api.saveStableBridge).not.toHaveBeenCalled();
    app.click('open-stable-bridge-onboarding'); await flush();
    expect(app.api.openStableBridgeSetup).toHaveBeenCalledOnce();
    expect(app.api.openHosted).not.toHaveBeenCalled();
  });

  it('saves a masked connector credential and guides routing without enabling access', async () => {
    const app = await mount(state('running'));
    app.click('nav-connections'); await flush(); app.click('start-bridge');
    app.fill('bridge-origin', 'https://memory.example.com'); app.fill('bridge-token', 'PRIVATE-CONNECTOR-TOKEN');
    app.fill('bridge-name', 'My remembered ChatGPT'); app.get<HTMLInputElement>('bridge-consent').checked = true;
    app.submit('bridge-form');
    expect(app.get<HTMLInputElement>('bridge-token').value).toBe('');
    await flush();
    expect(app.api.saveStableBridge).toHaveBeenCalledWith({ provider: 'cloudflare', origin: 'https://memory.example.com', token: 'PRIVATE-CONNECTOR-TOKEN',
      policy: { client: 'chatgpt-web', name: 'My remembered ChatGPT', permissions: ['notes:read'], expiresInDays: 30 } });
    expect(app.get('bridge-status-label').textContent).toBe('Web access is paused');
    expect(app.get('bridge-saved-url').textContent).toBe('https://memory.example.com/mcp');
    expect(app.get('bridge-target').textContent).toBe('http://127.0.0.1:49111');
    expect(app.get('bridge-route-instructions').textContent).toContain('dedicated Cloudflare Tunnel');
    expect(app.dom.window.document.body.textContent).not.toContain('PRIVATE-CONNECTOR-TOKEN');
    expect(app.get('bridge-form').hidden).toBe(true);
    expect(app.get('bridge-setup-ready').hidden).toBe(true);
    expect(app.api.resumeBridge).not.toHaveBeenCalled(); expect(app.api.startBridge).not.toHaveBeenCalled();
    app.click('copy-stable-bridge-target'); await flush();
    expect(app.api.copyStableBridgeTarget).toHaveBeenCalledOnce();
  });

  it('supports an existing HTTPS gateway without sending a Cloudflare credential', async () => {
    const app = await mount(state('running'));
    app.click('nav-connections'); await flush(); app.click('start-bridge');
    app.fill('bridge-token', 'DO-NOT-SEND'); app.fill('bridge-address-mode', 'external');
    app.get('bridge-address-mode').dispatchEvent(new app.dom.window.Event('change'));
    expect(app.get('bridge-token-field').hidden).toBe(true);
    expect(app.get<HTMLInputElement>('bridge-token').value).toBe('');
    app.fill('bridge-origin', 'https://memory.example.com'); app.get<HTMLInputElement>('bridge-consent').checked = true;
    app.submit('bridge-form'); await flush();
    expect(app.api.saveStableBridge).toHaveBeenCalledWith({ provider: 'external', origin: 'https://memory.example.com',
      policy: { client: 'chatgpt-web', name: 'ChatGPT web', permissions: ['notes:read'], expiresInDays: 30 } });
    expect(app.get('bridge-saved-provider').textContent).toContain('existing HTTPS gateway');
    expect(app.get('open-stable-bridge-setup').hidden).toBe(true);
    expect(app.api.resumeBridge).not.toHaveBeenCalled();
  });

  it('loads remembered settings and approvals while staying paused after a new app launch', async () => {
    const settings = stableView();
    const app = await mount(state('running'), {}, [], [], settings);
    app.setBridge(webPaused(settings, [connection('remembered-web', 'active')])); await app.poll();
    app.click('nav-connections'); await flush();
    expect(app.get('bridge-status-label').textContent).toBe('Web access is paused');
    expect(app.get('start-bridge').hidden).toBe(true);
    expect(app.get('resume-bridge').hidden).toBe(false);
    expect(app.get('bridge-connections').textContent).toContain('Paused (pairing saved)');
    expect(app.get('bridge-alert').hidden).toBe(true);
    expect(app.api.resumeBridge).not.toHaveBeenCalled(); expect(app.api.startBridge).not.toHaveBeenCalled();
    app.click('bridge-setup-details'); app.click('copy-stable-bridge-url'); await flush();
    expect(app.api.copyBridgeUrl).toHaveBeenCalledOnce();
    expect(app.get('bridge-saved-url').textContent).toBe('https://memory.example.com/mcp');
    expect(app.get('bridge-setup-ready').hidden).toBe(true);
  });

  it('resumes the saved address explicitly and pauses it without forgetting pairings', async () => {
    const settings = stableView(); const app = await mount(state('running'), {}, [], [], settings);
    app.setBridge(webPaused(settings, [connection('remembered-web', 'active')])); await app.poll();
    app.click('resume-bridge'); await flush();
    expect(app.api.resumeBridge).toHaveBeenCalledOnce(); expect(app.api.startBridge).not.toHaveBeenCalled();
    expect(app.get('bridge-status-label').textContent).toBe('Web access is on');
    expect(app.get('bridge-url').textContent).toBe('https://memory.example.com/mcp');
    expect(app.api.approveBridge).not.toHaveBeenCalled();
    app.click('stop-bridge'); await flush();
    expect(app.get('bridge-status-label').textContent).toBe('Web access is paused');
    expect(app.get('bridge-connections').textContent).toContain('Paused (pairing saved)');
    expect(app.api.forgetStableBridge).not.toHaveBeenCalled();
    expect(app.get('bridge-message').textContent).toContain('approved pairings are kept');
  });

  it('disconnects an individual remembered pairing while web access is paused', async () => {
    const app = await mount(state('stopped'), {}, [], [], stableView());
    app.setBridge(webPaused(stableView(), [connection('remembered-web', 'active')])); await app.poll();
    app.get('bridge-connections').querySelector<HTMLButtonElement>('.danger')!.click(); await flush();
    expect(app.api.revokeConnection).toHaveBeenCalledWith('remembered-web');
    expect(app.get('bridge-connections').textContent).toContain('Disconnected');
    expect(app.api.resumeBridge).not.toHaveBeenCalled();
  });

  it('requires a separate confirmation to forget an address and preserves notes', async () => {
    const app = await mount(state('running', 1), {}, [note()], [], stableView());
    app.click('bridge-setup-details'); app.click('forget-stable-bridge');
    expect(app.get('bridge-forget-review').hidden).toBe(false);
    expect(app.get<HTMLButtonElement>('confirm-forget-stable-bridge').disabled).toBe(true);
    expect(app.api.forgetStableBridge).not.toHaveBeenCalled();
    app.get<HTMLInputElement>('bridge-forget-confirm').checked = true;
    app.get('bridge-forget-confirm').dispatchEvent(new app.dom.window.Event('change'));
    app.click('confirm-forget-stable-bridge'); await flush();
    expect(app.api.forgetStableBridge).toHaveBeenCalledOnce();
    expect(app.get('bridge-status-label').textContent).toBe('Web access is off');
    expect(app.get('bridge-saved').hidden).toBe(true); expect(app.get('bridge-form').hidden).toBe(false);
    expect(app.get('bridge-message').textContent).toContain('provider’s tunnel and DNS remain');
    expect(app.get('notes-list').textContent).toContain('A note to keep');
    expect(app.api.setup).not.toHaveBeenCalled(); expect(app.api.restore).not.toHaveBeenCalled();
  });

  it('can cancel forgetting without changing the stored address', async () => {
    const app = await mount(state('running'), {}, [], [], stableView());
    app.click('bridge-setup-details'); app.click('forget-stable-bridge'); app.click('cancel-forget-stable-bridge');
    expect(app.get('bridge-forget-review').hidden).toBe(true);
    expect(app.get('bridge-saved-url').textContent).toBe('https://memory.example.com/mcp');
    expect(app.api.forgetStableBridge).not.toHaveBeenCalled();
  });

  it('keeps a failed public route paused and its saved settings available to retry', async () => {
    const failed = { ...webPaused(), state: 'error' as const, message: 'The provider route did not reach this pod.' };
    const app = await mount(state('running'), { resumeBridge: vi.fn(async (): Promise<BridgeStatus> => failed) }, [], [], stableView());
    app.click('resume-bridge'); await flush();
    expect(app.get('bridge-status-label').textContent).toBe('Web access needs another try');
    expect(app.get('bridge-message').textContent).toBe('The provider route did not reach this pod.');
    expect(app.get('bridge-saved-url').textContent).toBe('https://memory.example.com/mcp');
    expect(app.get('bridge-setup-ready').hidden).toBe(true);
    expect(app.get<HTMLButtonElement>('resume-bridge').disabled).toBe(false);
    expect(app.api.approveBridge).not.toHaveBeenCalled();
  });

  it('ignores old settings that return after the owner forgets an address', async () => {
    const oldStatus = deferred<BridgeStatus>(); const oldSettings = deferred<StableBridgeView | null>();
    const statusCheck = vi.fn<DesktopApi['bridgeStatus']>().mockResolvedValueOnce(webPaused()).mockImplementationOnce(() => oldStatus.promise)
      .mockResolvedValue({ state: 'off', permissions: [], pendingApprovals: [], connections: [] });
    const settingsCheck = vi.fn<DesktopApi['stableBridgeSettings']>().mockResolvedValueOnce(stableView()).mockImplementationOnce(() => oldSettings.promise).mockResolvedValue(null);
    const app = await mount(state('running'), { bridgeStatus: statusCheck, stableBridgeSettings: settingsCheck }, [], [], stableView());
    app.click('bridge-setup-details'); app.click('refresh-bridge'); app.click('forget-stable-bridge');
    app.get<HTMLInputElement>('bridge-forget-confirm').checked = true; app.get('bridge-forget-confirm').dispatchEvent(new app.dom.window.Event('change'));
    app.click('confirm-forget-stable-bridge'); await flush();
    oldStatus.resolve(webPaused()); oldSettings.resolve(stableView()); await flush();
    expect(app.get('bridge-status-label').textContent).toBe('Web access is off');
    expect(app.get('bridge-saved-url').textContent).toBe(''); expect(app.get('bridge-saved').hidden).toBe(true);
    expect(app.api.resumeBridge).not.toHaveBeenCalled();
  });

  it('ignores a late stable resume after the owner pauses the connection', async () => {
    const ready = deferred<BridgeStatus>();
    const app = await mount(state('running'), { resumeBridge: vi.fn(() => ready.promise) }, [], [], stableView());
    app.click('resume-bridge'); app.click('stop-bridge'); await flush();
    ready.resolve({ ...webPaused(), state: 'ready' }); await flush();
    expect(app.get('bridge-status-label').textContent).toBe('Web access is paused');
    expect(app.get('bridge-setup-ready').hidden).toBe(true);
    expect(app.get('bridge-saved-url').textContent).toBe('https://memory.example.com/mcp');
  });

  it('clears a submitted credential even if saving fails and never displays the error secret', async () => {
    const app = await mount(state('running'), { saveStableBridge: vi.fn(async () => { throw new Error('PRIVATE-SECRET'); }) });
    app.click('start-bridge'); app.fill('bridge-origin', 'https://memory.example.com'); app.fill('bridge-token', 'PRIVATE-SECRET');
    app.get<HTMLInputElement>('bridge-consent').checked = true; app.submit('bridge-form'); await flush();
    expect(app.get<HTMLInputElement>('bridge-token').value).toBe('');
    expect(app.get('bridge-dialog-message').textContent).toContain('could not be saved');
    expect(app.dom.window.document.body.textContent).not.toContain('PRIVATE-SECRET');
    expect(app.api.resumeBridge).not.toHaveBeenCalled();
  });

  it('clears an unsubmitted token when setup closes', async () => {
    const app = await mount(state('running'));
    app.click('start-bridge'); app.fill('bridge-token', 'PRIVATE-UNSUBMITTED'); app.click('close-bridge');
    expect(app.get<HTMLInputElement>('bridge-token').value).toBe('');
    expect(app.api.saveStableBridge).not.toHaveBeenCalled();
  });

  it('can explicitly reset unreadable saved settings without claiming access is off first', async () => {
    const settings = vi.fn<DesktopApi['stableBridgeSettings']>().mockRejectedValueOnce(new Error('Protected settings unavailable')).mockResolvedValue(null);
    const app = await mount(state('running'), { stableBridgeSettings: settings });
    expect(app.get('bridge-status-label').textContent).toContain('could not be checked');
    expect(app.get<HTMLButtonElement>('start-bridge').disabled).toBe(true);
    expect(app.get<HTMLButtonElement>('stop-bridge').disabled).toBe(false);
    expect(app.get('reset-web-setup').hidden).toBe(false);
    app.click('reset-web-setup');
    expect(app.get<HTMLDialogElement>('bridge-dialog').open).toBe(true);
    expect(app.get('bridge-forget-review').hidden).toBe(false);
    expect(app.get('bridge-forget-review').closest('[hidden]')).toBeNull();
    expect(app.get<HTMLButtonElement>('confirm-forget-stable-bridge').disabled).toBe(true);
    expect(app.api.forgetStableBridge).not.toHaveBeenCalled();
    app.get<HTMLInputElement>('bridge-forget-confirm').checked = true;
    app.get('bridge-forget-confirm').dispatchEvent(new app.dom.window.Event('change'));
    app.click('confirm-forget-stable-bridge'); await flush();
    expect(app.api.forgetStableBridge).toHaveBeenCalledOnce();
    expect(app.get('bridge-status-label').textContent).toBe('Web access is off');
    expect(app.get('reset-web-setup').hidden).toBe(true);
    expect(app.get('bridge-form').hidden).toBe(false);
    expect(app.get<HTMLSelectElement>('bridge-address-mode').value).toBe('cloudflare');
    expect(app.api.startBridge).not.toHaveBeenCalled(); expect(app.api.resumeBridge).not.toHaveBeenCalled();
  });

  it('stays off by default and keeps local and hosted choices separate', async () => {
    const app = await mount(state('running'));
    app.click('nav-connections'); await flush();
    expect(app.get('bridge-status-label').textContent).toBe('Web access is off');
    expect(app.get('bridge-alert').hidden).toBe(true);
    expect(app.api.startBridge).not.toHaveBeenCalled();
    app.click('start-bridge'); app.temporary();
    expect(app.get<HTMLDialogElement>('bridge-dialog').open).toBe(true);
    expect(app.get<HTMLInputElement>('bridge-read').checked).toBe(true);
    expect(app.get<HTMLInputElement>('bridge-create').checked).toBe(false);
    expect(app.get<HTMLInputElement>('bridge-consent').checked).toBe(false);
    expect(app.get<HTMLSelectElement>('bridge-expiry').value).toBe('30');
    expect(app.get<HTMLButtonElement>('confirm-bridge-start').disabled).toBe(true);
    expect(app.get('bridge-dialog').textContent).toContain('Cloudflare handles connection traffic');
    expect(app.get('bridge-dialog').textContent).toContain('address changes');
    expect(app.get('bridge-dialog').textContent).toContain('federation stays off');
    app.submit('bridge-form'); await flush();
    expect(app.api.startBridge).not.toHaveBeenCalled();
    app.click('cancel-bridge'); app.click('connections-hosted'); await flush();
    expect(app.api.openHosted).toHaveBeenCalledTimes(1);
    expect(app.api.createConnection).not.toHaveBeenCalled();
  });

  it('requires explicit consent, preserves choices and starts only the selected permissions', async () => {
    const app = await mount(state('running'));
    app.click('nav-connections'); await flush(); app.click('start-bridge'); app.temporary();
    app.fill('bridge-client', 'grok-bot'); app.get('bridge-client').dispatchEvent(new app.dom.window.Event('change'));
    expect(app.get<HTMLInputElement>('bridge-name').value).toBe('Grok Bot');
    app.fill('bridge-name', 'My Grok Bot'); app.fill('bridge-expiry', '7');
    app.get<HTMLInputElement>('bridge-read').checked = false;
    app.get<HTMLInputElement>('bridge-create').checked = true;
    app.get('bridge-create').dispatchEvent(new app.dom.window.Event('change'));
    expect(app.get('bridge-scope-help').textContent).toContain('cannot read');
    await app.poll();
    expect(app.get<HTMLInputElement>('bridge-name').value).toBe('My Grok Bot');
    app.get<HTMLInputElement>('bridge-consent').checked = true;
    app.get('bridge-consent').dispatchEvent(new app.dom.window.Event('change'));
    app.submit('bridge-form'); app.submit('bridge-form'); await flush();
    expect(app.api.startBridge).toHaveBeenCalledTimes(1);
    expect(app.api.startBridge).toHaveBeenCalledWith({ client: 'grok-bot', name: 'My Grok Bot', permissions: ['notes:create'], expiresInDays: 7 });
    expect(app.get('bridge-status-label').textContent).toBe('Temporary web access is on');
    expect(app.get('bridge-client-instructions').textContent).toContain('Grok Bot');
    expect(app.get('bridge-url').textContent).toBe('https://sample.trycloudflare.com/mcp');
    expect(app.get('bridge-setup-ready').textContent).toContain('does not connect your assistant');
    expect(app.api.approveBridge).not.toHaveBeenCalled();
  });

  it('validates missing permissions and lets web setup be retried without changing the pod', async () => {
    const app = await mount(state('running'));
    app.click('nav-connections'); await flush(); app.click('start-bridge'); app.temporary();
    app.get<HTMLInputElement>('bridge-read').checked = false;
    app.get<HTMLInputElement>('bridge-consent').checked = true;
    app.get('bridge-read').dispatchEvent(new app.dom.window.Event('change'));
    expect(app.get<HTMLButtonElement>('confirm-bridge-start').disabled).toBe(true);
    app.submit('bridge-form'); await flush();
    expect(app.api.startBridge).not.toHaveBeenCalled();
    app.get<HTMLInputElement>('bridge-read').checked = true;
    app.fill('bridge-name', ''); app.submit('bridge-form'); await flush();
    expect(app.api.startBridge).not.toHaveBeenCalled();
    expect(app.get('bridge-dialog-message').getAttribute('role')).toBe('alert');
    expect(app.api.setup).not.toHaveBeenCalled();
  });

  it('keeps Stop and local notes usable while startup is pending, and ignores its late ready result', async () => {
    const start = deferred<BridgeStatus>();
    const app = await mount(state('running'), { startBridge: vi.fn(() => start.promise) });
    app.click('nav-connections'); await flush(); app.click('start-bridge'); app.temporary();
    app.get<HTMLInputElement>('bridge-consent').checked = true; app.submit('bridge-form');
    expect(app.get('bridge-setup-progress').hidden).toBe(false);
    expect(app.get<HTMLButtonElement>('stop-bridge-setup').disabled).toBe(false);
    app.click('close-bridge'); app.click('nav-memory');
    expect(app.get<HTMLButtonElement>('save-note').disabled).toBe(false);
    app.fill('note-title', 'Still local'); app.fill('note-body', 'Still available.'); app.submit('note-form'); await flush();
    expect(app.api.saveNote).toHaveBeenCalledTimes(1);
    app.click('bridge-alert-stop'); await flush();
    expect(app.api.stopBridge).toHaveBeenCalledTimes(1);
    expect(app.get('bridge-status-label').textContent).toBe('Web access is off');
    start.resolve(webReady()); await flush();
    expect(app.get('bridge-status-label').textContent).toBe('Web access is off');
    expect(app.get('bridge-url').textContent).toBe('');
  });

  it('checks incoming approvals on the memory page and requires a code match before allowing', async () => {
    const app = await mount(state('running'));
    app.setBridge({ ...webReady(), pendingApprovals: [webRequest()] }); await app.poll();
    expect(app.get('memory-page').hidden).toBe(false);
    expect(app.get('bridge-alert').hidden).toBe(false);
    expect(app.get('bridge-alert-title').textContent).toContain('asking to connect');
    app.click('bridge-review'); await flush();
    expect(app.get('connections-page').hidden).toBe(false);
    const request = app.get('bridge-approvals').querySelector<HTMLElement>('[data-approval-id="request-1"]')!;
    expect(request.textContent).toContain('1234-5678');
    expect(request.textContent).toContain('https://chatgpt.com');
    expect(request.textContent).toContain('Maximum access: 30 days');
    const allow = request.querySelector<HTMLButtonElement>('.primary')!;
    expect(allow.disabled).toBe(true); allow.click();
    expect(app.api.approveBridge).not.toHaveBeenCalled();
    const match = request.querySelector<HTMLInputElement>('input')!; match.checked = true;
    match.dispatchEvent(new app.dom.window.Event('change'));
    await app.poll();
    expect(app.get('bridge-approvals').querySelector<HTMLInputElement>('input')!.checked).toBe(true);
    app.get('bridge-approvals').querySelector<HTMLButtonElement>('.primary')!.click(); await flush();
    expect(app.api.approveBridge).toHaveBeenCalledWith('request-1');
    expect(app.get('bridge-approvals-section').hidden).toBe(true);
    expect(app.get('bridge-connections').textContent).toContain('Waiting for first use');
    expect(app.get('connections-list').textContent).toContain('Web assistant');
    expect(app.get('connections-list').querySelector<HTMLButtonElement>('.secondary')!.textContent).toBe('Web setup');
    app.get('connections-list').querySelector<HTMLButtonElement>('.secondary')!.click(); await flush();
    expect(app.api.connectionSetup).not.toHaveBeenCalled();
  });

  it('denies unsolicited requests without requiring a match and renders app names literally', async () => {
    const app = await mount(state('running'));
    app.setBridge({ ...webReady(), pendingApprovals: [{ ...webRequest(), clientName: '<img src=x onerror=bad()>' }] }); await app.poll();
    app.click('bridge-review'); await flush();
    expect(app.get('bridge-approvals').textContent).toContain('<img src=x');
    expect(app.get('bridge-approvals').querySelector('img')).toBeNull();
    app.get('bridge-approvals').querySelector<HTMLButtonElement>('.secondary')!.click(); await flush();
    expect(app.api.denyBridge).toHaveBeenCalledWith('request-1');
    expect(app.api.approveBridge).not.toHaveBeenCalled();
    expect(app.get('bridge-approvals-section').hidden).toBe(true);
  });

  it('drops code acknowledgements when the request code changes', async () => {
    const app = await mount(state('running'));
    app.setBridge({ ...webReady(), pendingApprovals: [webRequest()] }); await app.poll();
    const match = app.get('bridge-approvals').querySelector<HTMLInputElement>('input')!;
    match.checked = true; match.dispatchEvent(new app.dom.window.Event('change'));
    app.setBridge({ ...webReady(), pendingApprovals: [{ ...webRequest(), verificationCode: '9999-1111' }] }); await app.poll();
    expect(app.get('bridge-approvals').querySelector<HTMLInputElement>('input')!.checked).toBe(false);
    expect(app.get('bridge-approvals').querySelector<HTMLButtonElement>('.primary')!.disabled).toBe(true);
    expect(app.get('bridge-approvals').textContent).toContain('9999-1111');
  });

  it('shows unknown instead of off after a failed check and blocks stale approvals until retry', async () => {
    const check = vi.fn<DesktopApi['bridgeStatus']>().mockResolvedValue({ ...webReady(), pendingApprovals: [webRequest()] });
    const app = await mount(state('running'), { bridgeStatus: check });
    check.mockRejectedValueOnce(new Error('Unavailable')); await app.poll();
    expect(app.get('bridge-status-label').textContent).toContain('could not be checked');
    expect(app.get('bridge-status-label').textContent).not.toBe('Web access is off');
    expect(app.get('bridge-approvals').querySelector('button')).toBeNull();
    expect(app.get<HTMLButtonElement>('copy-bridge-url').disabled).toBe(true);
    expect(app.get<HTMLButtonElement>('stop-bridge').disabled).toBe(false);
    app.click('refresh-bridge'); await flush();
    expect(app.get('bridge-status-label').textContent).toBe('Temporary web access is on');
    expect(app.get('bridge-approvals').querySelector<HTMLInputElement>('input')!.checked).toBe(false);
  });

  it('ignores an old status response that arrives after Stop', async () => {
    const stale = deferred<BridgeStatus>();
    const check = vi.fn<DesktopApi['bridgeStatus']>().mockResolvedValueOnce(webReady()).mockImplementationOnce(() => stale.promise)
      .mockResolvedValue({ state: 'off', permissions: [], pendingApprovals: [], connections: [] });
    const app = await mount(state('running'), { bridgeStatus: check });
    app.click('refresh-bridge'); app.click('stop-bridge'); await flush();
    stale.resolve({ ...webReady(), pendingApprovals: [webRequest()] }); await flush();
    expect(app.get('bridge-status-label').textContent).toBe('Web access is off');
    expect(app.get('bridge-approvals').textContent).toBe('');
    expect(app.get('bridge-url').textContent).toBe('');
  });

  it('ignores a late approval result when the owner has stopped web access', async () => {
    const approval = deferred<BridgeStatus>();
    const app = await mount(state('running'), { approveBridge: vi.fn(() => approval.promise) });
    app.setBridge({ ...webReady(), pendingApprovals: [webRequest()] }); await app.poll();
    const match = app.get('bridge-approvals').querySelector<HTMLInputElement>('input')!;
    match.checked = true; match.dispatchEvent(new app.dom.window.Event('change'));
    app.get('bridge-approvals').querySelector<HTMLButtonElement>('.primary')!.click();
    app.click('bridge-alert-stop'); await flush();
    approval.resolve({ ...webReady(), connections: [connection('web-grant', 'active')] }); await flush();
    expect(app.get('bridge-status-label').textContent).toBe('Web access is off');
    expect(app.get('bridge-connections').textContent).toBe('');
    expect(app.get('bridge-message').textContent).not.toContain('Connection allowed');
  });

  it('copies the safe URL and opens only the chosen client through owner APIs', async () => {
    const app = await mount(state('running'));
    app.setBridge({ ...webReady(), client: 'grok-bot' }); await app.poll();
    app.click('bridge-setup-details'); app.click('copy-bridge-url'); await flush();
    expect(app.api.copyBridgeUrl).toHaveBeenCalledWith();
    expect(app.get('bridge-dialog-message').textContent).toContain('URL copied');
    app.click('open-bridge-client'); await flush();
    expect(app.api.openBridgeClient).toHaveBeenCalledWith('grok-bot');
    expect(app.api.approveBridge).not.toHaveBeenCalled();
  });

  it('reports clipboard failure without claiming copy or starting a new connection', async () => {
    const app = await mount(state('running'), { copyBridgeUrl: vi.fn(async () => { throw new Error('Unavailable'); }) });
    app.setBridge(webReady()); await app.poll(); app.click('bridge-setup-details'); app.click('copy-bridge-url'); await flush();
    expect(app.get('bridge-dialog-message').textContent).toContain('could not be copied');
    expect(app.get('bridge-dialog-message').textContent).not.toContain('URL copied');
    expect(app.api.startBridge).not.toHaveBeenCalled();
  });

  it('waits for confirmed revocation before labelling a web grant disconnected', async () => {
    const revoke = deferred<void>();
    const app = await mount(state('running'), { revokeConnection: vi.fn(() => revoke.promise) });
    app.setBridge({ ...webReady(), connections: [connection('web-grant', 'active')] }); await app.poll();
    app.get('bridge-connections').querySelector<HTMLButtonElement>('.danger')!.click();
    expect(app.get('bridge-connections').textContent).toContain('Access allowed');
    app.setBridge({ ...webReady(), connections: [connection('web-grant', 'revoked')] }); revoke.resolve(); await flush();
    expect(app.api.revokeConnection).toHaveBeenCalledWith('web-grant');
    expect(app.get('bridge-connections').textContent).toContain('Disconnected');
    expect(app.get('bridge-connections').querySelector('button')).toBeNull();
  });

  it('disables creation while the pod is stopped or restoring without blocking Stop', async () => {
    const app = await mount(state('stopped'));
    expect(app.get<HTMLButtonElement>('start-bridge').disabled).toBe(true);
    expect(app.get('bridge-availability').textContent).toContain('Start your local space');
    app.setStatus({ ...state('running'), restorePending: true }); await app.poll();
    expect(app.get<HTMLButtonElement>('start-bridge').disabled).toBe(true);
    app.setBridge(webReady()); await app.poll();
    expect(app.get<HTMLButtonElement>('stop-bridge').disabled).toBe(false);
    expect(app.get('bridge-availability').textContent).toContain('Finish restoring');
  });

  it('shows a truthful startup failure and keeps the selected form available to retry', async () => {
    const app = await mount(state('running'), { startBridge: vi.fn(async () => { throw new Error('Unavailable'); }) });
    app.click('nav-connections'); await flush(); app.click('start-bridge'); app.temporary(); app.fill('bridge-name', 'Keep this name');
    app.get<HTMLInputElement>('bridge-consent').checked = true; app.submit('bridge-form'); await flush();
    expect(app.get('bridge-dialog-message').textContent).toContain('could not start');
    expect(app.get('bridge-form').hidden).toBe(false);
    expect(app.get<HTMLInputElement>('bridge-name').value).toBe('Keep this name');
    expect(app.get('bridge-setup-ready').hidden).toBe(true);
    expect(app.get<HTMLButtonElement>('confirm-bridge-start').disabled).toBe(false);
    expect(app.api.setup).not.toHaveBeenCalled();
  });

  it('does not claim the URL is ready when native startup resolves with an error status', async () => {
    const app = await mount(state('running'), { startBridge: vi.fn(async (): Promise<BridgeStatus> => ({ state: 'error',
      message: 'The temporary link could not open.', permissions: [], pendingApprovals: [], connections: [] })) });
    app.click('nav-connections'); await flush(); app.click('start-bridge'); app.temporary();
    app.get<HTMLInputElement>('bridge-consent').checked = true; app.submit('bridge-form'); await flush();
    expect(app.get('bridge-status-label').textContent).toBe('Web access needs another try');
    expect(app.get('bridge-dialog-message').textContent).toBe('The temporary link could not open.');
    expect(app.get('bridge-dialog-message').getAttribute('role')).toBe('alert');
    expect(app.get('bridge-url').textContent).toBe('');
    expect(app.get('bridge-setup-ready').hidden).toBe(true);
    expect(app.get<HTMLButtonElement>('confirm-bridge-start').disabled).toBe(false);
  });
});
