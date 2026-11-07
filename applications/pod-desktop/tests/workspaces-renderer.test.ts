/** Actual shipping Workspace renderer and HTML, with the real local service behind its IPC-shaped port. */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import type { DesktopApi, PodStatus } from '../src/types.js';
import type { AgentConnection } from '../src/agent-types.js';
import type { DiscordWorkspaceConfiguration, DiscordWorkspaceStatus } from '../src/discord-workspaces.js';
import { WorkspaceService } from '../src/workspace-service.js';
import { WORKSPACE_ACTIONS as A, type WorkspaceActRequest, type WorkspacePrincipal, type WorkspaceRepresentation } from '../src/workspace-types.js';
import type { installWorkspacesUi } from '../src/workspaces-renderer.js';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..');
const documents: JSDOM[] = [];
let bundle: string;

beforeAll(async () => {
  const result = await build({ entryPoints: [join(APP, 'src/workspaces-renderer.ts')], bundle: true, format: 'iife',
    globalName: 'InteregoWorkspaces', platform: 'browser', target: 'es2022', write: false, logLevel: 'silent' });
  bundle = result.outputFiles[0]!.text;
}, 60_000);
afterEach(() => { for (const dom of documents.splice(0)) dom.window.close(); });

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) await new Promise<void>(done => setImmediate(done));
}
const podStatus = (running: boolean): PodStatus => ({ state: running ? 'running' : 'stopped', configured: true,
  running, localOnly: true, federationEnabled: false, noteCount: 0 });
const initialDiscord = (): DiscordWorkspaceStatus => ({ configured: false, running: false, state: 'off',
  participants: [], receivedCount: 0, sentCount: 0, disclosure: 'Discord can read bridged messages. Every launch starts off.' });
type WorkspaceUiApi = Pick<DesktopApi, 'workspaceStatus' | 'workspaceAct' | 'connections' | 'discordWorkspaceStatus'
  | 'configureDiscordWorkspace' | 'startDiscordWorkspace' | 'stopDiscordWorkspace' | 'disconnectDiscordWorkspace' | 'openDiscordWorkspaceSetup'>;

async function mount(overrides: Partial<WorkspaceUiApi> = {}) {
  let persisted: unknown | null = null;
  const service = new WorkspaceService({ binding: async () => 'isolated-renderer-pod',
    store: { load: async () => structuredClone(persisted), save: async value => { persisted = structuredClone(value); } } });
  let currentPod = podStatus(true);
  let grants: readonly AgentConnection[] = [];
  let discord = initialDiscord();
  const api: WorkspaceUiApi = {
    workspaceStatus: vi.fn(() => service.status()),
    workspaceAct: vi.fn((request: WorkspaceActRequest) => service.act(request)),
    connections: vi.fn(async () => grants),
    discordWorkspaceStatus: vi.fn(async () => discord),
    configureDiscordWorkspace: vi.fn(async (configuration: DiscordWorkspaceConfiguration) => {
      discord = { ...initialDiscord(), configured: true, workspaceId: configuration.workspaceId,
        channelId: configuration.channelId, participants: configuration.participants }; return discord;
    }),
    startDiscordWorkspace: vi.fn(async () => { discord = { ...discord, running: true, state: 'running' }; return discord; }),
    stopDiscordWorkspace: vi.fn(async () => { discord = { ...discord, running: false, state: 'off' }; return discord; }),
    disconnectDiscordWorkspace: vi.fn(async () => { discord = initialDiscord(); return discord; }),
    openDiscordWorkspaceSetup: vi.fn(async () => undefined),
    ...overrides,
  };
  const dom = new JSDOM(readFileSync(join(APP, 'index.html'), 'utf8'), {
    url: 'file:///isolated-interego/index.html', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  documents.push(dom);
  // esbuild's strict IIFE binding belongs to this eval scope, not window's property bag.
  // Read the real bundle's export in that same scope instead of replacing its implementation.
  const exports = dom.window.eval(`${bundle}\n;InteregoWorkspaces;`) as { installWorkspacesUi: typeof installWorkspacesUi };
  const ui = exports.installWorkspacesUi(api as DesktopApi, { pod: () => currentPod, busy: () => false });
  const get = <T extends HTMLElement = HTMLElement>(id: string): T => {
    const found = dom.window.document.getElementById(id); if (!found) throw new Error(`Missing shipped control ${id}`); return found as T;
  };
  ui.show(true); await flush();
  const app = { api, dom, service, ui, get,
    click: async (id: string) => { get<HTMLButtonElement>(id).click(); await flush(); },
    submit: async (id: string) => { get(id).dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })); await flush(); },
    fill: (id: string, value: string) => { get<HTMLInputElement | HTMLTextAreaElement>(id).value = value; },
    setGrants: (values: readonly AgentConnection[]) => { grants = values; },
    setRunning: (running: boolean) => { currentPod = podStatus(running); ui.updateAvailability(); },
  };
  return app;
}
type Mounted = Awaited<ReturnType<typeof mount>>;
async function createRoom(app: Mounted, title = 'Family ideas') {
  await app.click('workspace-enable'); app.fill('workspace-title', title); await app.submit('workspace-create');
  const room = (await app.service.status()).workspaces?.[0]; if (!room) throw new Error('The shipping UI did not create a workspace');
  return room;
}
function advertised(view: WorkspaceRepresentation, action: string) {
  const found = view.affordances.find(value => value.action === action); if (!found) throw new Error(`No advertised action ${action}`);
  return { action: found.action, target: found.target };
}

describe('optional Workspace chat in the shipping renderer', () => {
  it('starts off, follows discovered actions and renders the human message as text with service-derived authorship', async () => {
    const app = await mount();
    expect(app.get('workspace-content').hidden).toBe(true);
    expect(app.get<HTMLButtonElement>('workspace-enable').hidden).toBe(false);
    expect(app.api.workspaceAct).not.toHaveBeenCalled();
    expect(app.api.startDiscordWorkspace).not.toHaveBeenCalled();
    const room = await createRoom(app, '<img src=x onerror=alert(1)>');
    const body = '<script>window.stolen = true</script>\nAn exact message.';
    app.fill('workspace-body', body); await app.submit('workspace-post');
    expect(app.get('workspace-room-title').textContent).toBe('<img src=x onerror=alert(1)>');
    expect(app.get('workspace-messages').textContent).toContain(body);
    expect(app.get('workspace-messages').querySelector('script,img')).toBeNull();
    expect(app.get('workspace-room-title').querySelector('img')).toBeNull();
    expect(app.get('workspace-messages').querySelector('strong')?.textContent).toBe('You');
    expect(app.api.workspaceAct).toHaveBeenLastCalledWith({ action: A.POST, target: room.id, input: { body } });
    const stored = await app.service.act(advertised(await app.service.status(), A.READ));
    expect(stored.workspace?.entries[0]?.author).toMatchObject({ kind: 'human', name: 'You' });
    expect(stored.workspace?.entries[0]?.author.id).toBe(stored.workspace?.owner);
    expect(stored.workspace?.entries[0]?.author['@id']).toBe(stored.workspace?.owner);
    expect(stored.localOnly).toBe(true); expect(stored.federationEnabled).toBe(false);
    await app.click('workspace-disable');
    expect(app.get('workspace-content').hidden).toBe(true);
    expect((await app.service.status()).enabled).toBe(false);
  });

  it('invites only a scoped connection and requires the agent to accept before its post appears', async () => {
    const app = await mount(); const room = await createRoom(app);
    const id = '26bd4d01-af1f-4bb8-a132-86d4af7a3338';
    const connection: AgentConnection = { id, name: 'My helper', client: 'codex', state: 'active',
      permissions: ['workspaces:read', 'workspaces:chat'], workspaceIds: [room.id], createdAt: '2026-10-30T12:00:00Z', expiresAt: '2099-10-30T12:00:00Z' };
    app.setGrants([connection, { ...connection, id: '06c73060-b296-46d4-99d5-2ab896c73aa8', name: 'Unselected helper', workspaceIds: [] }]);
    await app.ui.refresh(); await flush();
    const select = app.get<HTMLSelectElement>('workspace-invite-agent');
    expect(Array.from(select.options).map(option => option.textContent)).toEqual(['My helper']);
    await app.submit('workspace-invite');
    expect(app.get('workspace-members').textContent).toContain('My helper · agent · invited');
    const principal: WorkspacePrincipal = { id, name: connection.name, kind: 'agent', permissions: ['workspaces:read', 'workspaces:chat'],
      workspaceIds: [room.id], authorize: async () => undefined };
    const invitation = await app.service.status(principal);
    expect(invitation.affordances.some(value => value.action === A.POST)).toBe(false);
    const accepted = await app.service.act(advertised(invitation, A.ACCEPT), principal);
    await app.service.act({ ...advertised(accepted, A.POST), input: { body: 'I can help with this.' } }, principal);
    await app.ui.refresh(); await flush();
    expect(app.get('workspace-messages').textContent).toContain('My helper · Agent');
    expect(app.get('workspace-messages').textContent).toContain('I can help with this.');
    const remove = app.get('workspace-members').querySelector<HTMLButtonElement>('button[aria-label="Remove My helper from this workspace"]');
    expect(remove).not.toBeNull(); remove!.click(); await flush();
    expect(app.get('workspace-members').textContent).toContain('My helper · agent · revoked');
    expect((await app.service.status(principal)).affordances.some(value => value.action === A.POST)).toBe(false);
    expect(app.get('workspace-messages').textContent).toContain('I can help with this.');
  });

  it('reads earlier and newer bounded pages without losing the chosen history page on refresh', async () => {
    const app = await mount(); const room = await createRoom(app);
    const opening = await app.service.act(advertised(await app.service.status(), A.READ));
    const post = advertised(opening, A.POST);
    for (let index = 0; index < 25; index++) await app.service.act({ ...post, input: { body: `Message ${index}` } });
    const bodies = () => Array.from(app.get('workspace-messages').querySelectorAll('article > p')).map(value => value.textContent);
    await app.ui.refresh(); await flush();
    expect(bodies()).toEqual(Array.from({ length: 20 }, (_, index) => `Message ${index + 5}`));
    expect(app.get<HTMLButtonElement>('workspace-earlier').disabled).toBe(false);
    expect(app.get<HTMLButtonElement>('workspace-later').disabled).toBe(true);
    await app.click('workspace-earlier');
    expect(app.api.workspaceAct).toHaveBeenLastCalledWith({ action: A.READ, target: room.id, input: { beforeSeq: 5 } });
    expect(bodies()).toEqual(Array.from({ length: 5 }, (_, index) => `Message ${index}`));
    expect(app.get<HTMLButtonElement>('workspace-earlier').disabled).toBe(true);
    expect(app.get<HTMLButtonElement>('workspace-later').disabled).toBe(false);
    await app.ui.refresh(); await flush();
    expect(bodies()).toEqual(Array.from({ length: 5 }, (_, index) => `Message ${index}`));
    await app.click('workspace-later');
    expect(app.api.workspaceAct).toHaveBeenLastCalledWith({ action: A.READ, target: room.id, input: { afterSeq: 4 } });
    expect(bodies()).toEqual(Array.from({ length: 20 }, (_, index) => `Message ${index + 5}`));
    expect(app.get('workspace-room-count').textContent).toContain('25 messages');
  });

  it('does not invoke a workflow action that the current representation does not advertise', async () => {
    const app = await mount(); await app.click('workspace-enable');
    vi.mocked(app.api.workspaceStatus).mockImplementation(async () => {
      const view = await app.service.status(); return { ...view, affordances: view.affordances.filter(value => value.action !== A.CREATE) };
    });
    await app.ui.refresh(); await flush(); vi.mocked(app.api.workspaceAct).mockClear();
    app.fill('workspace-title', 'Unavailable create'); await app.submit('workspace-create');
    expect(app.api.workspaceAct).not.toHaveBeenCalled();
    expect(app.get('workspace-feedback').textContent).toContain('action is no longer available');
    expect((await app.service.status()).workspaces).toEqual([]);
    app.setRunning(false);
    expect(app.get<HTMLButtonElement>('workspace-enable').disabled).toBe(true);
    expect(app.get<HTMLButtonElement>('workspace-create-button').disabled).toBe(true);
  });
});

describe('explicit Discord setup in the shipping Workspace renderer', () => {
  function fillDiscord(app: Mounted) {
    app.fill('workspace-discord-channel', 'https://discord.com/channels/123456789012345678/234567890123456789');
    app.fill('workspace-discord-token', 'isolated-test-token-never-real');
    app.fill('workspace-discord-people', '<@345678901234567890> | My brother');
    app.get<HTMLInputElement>('workspace-discord-consent').checked = true;
  }
  it('clears the bot secret, saves one selected room/channel and remains paused until Start is chosen', async () => {
    const app = await mount(); const room = await createRoom(app); fillDiscord(app);
    await app.submit('workspace-discord-form');
    expect(app.api.configureDiscordWorkspace).toHaveBeenCalledWith({ workspaceId: room.id, channelId: '234567890123456789',
      token: 'isolated-test-token-never-real', participants: [{ discordUserId: '345678901234567890', name: 'My brother' }], consent: true });
    expect(app.get<HTMLInputElement>('workspace-discord-token').value).toBe('');
    expect(app.get<HTMLInputElement>('workspace-discord-consent').checked).toBe(false);
    expect(app.get('workspace-discord-status').textContent).toContain('Saved and paused');
    expect(app.api.startDiscordWorkspace).not.toHaveBeenCalled();
    expect(app.dom.window.document.body.textContent).not.toContain('isolated-test-token-never-real');
    await app.click('workspace-discord-start'); expect(app.api.startDiscordWorkspace).toHaveBeenCalledOnce();
    expect(app.get('workspace-discord-status').textContent).toContain('Connected');
    await app.click('workspace-discord-stop'); expect(app.api.stopDiscordWorkspace).toHaveBeenCalledOnce();
    expect(app.get('workspace-discord-status').textContent).toContain('Saved and paused');
    await app.click('workspace-discord-forget'); expect(app.api.disconnectDiscordWorkspace).toHaveBeenCalledOnce();
    expect(app.get('workspace-discord-status').textContent).toContain('Not configured');
  });

  it('clears the bot secret when saving fails and never starts a connection after that refusal', async () => {
    const app = await mount({ configureDiscordWorkspace: vi.fn(async () => { throw new Error('Choose a valid Discord channel.'); }) });
    await createRoom(app); fillDiscord(app); await app.submit('workspace-discord-form');
    expect(app.get('workspace-feedback').textContent).toContain('Choose a valid Discord channel.');
    expect(app.get<HTMLInputElement>('workspace-discord-token').value).toBe('');
    expect(app.api.startDiscordWorkspace).not.toHaveBeenCalled();
    expect(app.dom.window.document.body.textContent).not.toContain('isolated-test-token-never-real');
  });
});
