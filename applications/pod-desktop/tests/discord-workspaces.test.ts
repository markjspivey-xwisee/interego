import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { DiscordWorkspaceBridge, type DiscordWorkspaceConfiguration, type DiscordWorkspaceOptions } from '../src/discord-workspaces.js';
import { WorkspaceService } from '../src/workspace-service.js';
import { WORKSPACE_ACTIONS as A } from '../src/workspace-types.js';
import type { GatewayHandlers, GatewayMessage } from '../../shared-workspace/discord/src/discord.js';

const bridges: DiscordWorkspaceBridge[] = [];
const directories: string[] = [];
const USER = '12345678901234567'; const CHANNEL = '22345678901234567';
const TOKEN = 'isolated-discord-token-not-a-real-credential';
const protector = { protect: (value: string) => Buffer.from(value).toString('base64'), unprotect: (value: string) => Buffer.from(value, 'base64').toString('utf8') };
afterEach(async () => {
  await Promise.all(bridges.splice(0).map(bridge => bridge.stop()));
  for (const directory of directories.splice(0)) {
    if (dirname(resolve(directory)) === resolve(tmpdir()) && basename(directory).startsWith('interego-discord-workspace-')) await rm(directory, { recursive: true, force: true });
  }
});
async function fixture() {
  let saved: unknown | null = null;
  const workspace = new WorkspaceService({ binding: async () => 'isolated-discord-pod', store: { load: async () => structuredClone(saved), save: async value => { saved = structuredClone(value); } } });
  await workspace.act({ action: A.ENABLE });
  const room = (await workspace.act({ action: A.CREATE, input: { title: 'Selected chat' } })).workspace!;
  const directory = await mkdtemp(join(tmpdir(), 'interego-discord-workspace-')); directories.push(directory);
  const requests: Array<{ url: string; init?: RequestInit; body?: Record<string, unknown> }> = [];
  let handlers!: GatewayHandlers; let connects = 0; let stops = 0;
  let failSend = false;
  const options: DiscordWorkspaceOptions = { dataDir: directory, protector, workspaces: workspace, pollMs: 10,
    fetch: async (url, init) => {
      const text = String(url); const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined;
      requests.push({ url: text, init, body });
      if (text.endsWith('/users/@me')) return Response.json({ id: '32345678901234567', username: 'Fixture bot' });
      if (text.endsWith(`/channels/${CHANNEL}`)) return Response.json({ id: CHANNEL, type: 11 });
      if (text.endsWith('/messages') && init?.method === 'POST') return failSend ? Response.json({}, { status: 503 }) : Response.json({ id: '42345678901234567' });
      throw new Error('Unexpected external request in isolated fixture.');
    },
    gateway: (_token, nextHandlers) => {
      handlers = nextHandlers;
      return { connect: () => { connects++; handlers.onNotice('gateway ready as fixture'); }, stop: () => { stops++; } };
    } };
  const bridge = new DiscordWorkspaceBridge(options); bridges.push(bridge);
  const input: DiscordWorkspaceConfiguration = { workspaceId: room.id, channelId: CHANNEL, token: TOKEN, participants: [{ discordUserId: USER, name: 'Brother' }], consent: true };
  const message = (overrides: Partial<GatewayMessage> = {}): GatewayMessage => ({ id: '52345678901234567', channelId: CHANNEL, authorId: USER, authorBot: false, content: 'Hello from Discord', replyToId: null, guildId: '62345678901234567', mentionedRoleIds: [], attachments: [], ...overrides });
  const entries = async () => (await workspace.act({ action: A.READ, target: room.id })).workspace!.entries;
  return { bridge, options, workspace, room, input, requests, directory, message, entries, handlers: () => handlers, connects: () => connects, stops: () => stops,
    failSend: (value: boolean) => { failSend = value; }, sends: () => requests.filter(request => request.init?.method === 'POST') };
}

describe('owner-selected local Workspace and Discord connection', () => {
  it('does no networking until Start and never exposes its protected token in status', async () => {
    const f = await fixture(); expect((await f.bridge.status()).state).toBe('off');
    await f.bridge.configure(f.input); expect(f.requests).toEqual([]); expect(f.connects()).toBe(0);
    const status = await f.bridge.status(); expect(status).toMatchObject({ configured: true, running: false, state: 'off', participants: f.input.participants });
    expect(JSON.stringify(status)).not.toContain(TOKEN);
    expect(await readFile(join(f.directory, 'discord-workspaces.json'), 'utf8')).not.toContain(TOKEN);
    await f.bridge.start(); expect(f.connects()).toBe(1); expect((await f.bridge.status()).running).toBe(true);
    expect(f.requests.every(request => new URL(request.url).hostname === 'discord.com')).toBe(true);
    expect(f.requests.every(request => request.init?.redirect === 'error')).toBe(true);
  });

  it('records only selected humans once and retains message attribution and durable duplicate protection', async () => {
    const f = await fixture(); await f.bridge.configure(f.input); await f.bridge.start();
    const handlers = f.handlers();
    handlers.onMessage(f.message()); handlers.onMessage(f.message());
    handlers.onMessage(f.message({ authorId: '72345678901234567' }));
    handlers.onMessage(f.message({ authorBot: true })); handlers.onMessage(f.message({ channelId: '82345678901234567' }));
    await vi.waitFor(async () => { expect(await f.entries()).toHaveLength(1); });
    expect((await f.entries())[0]).toMatchObject({ body: 'Hello from Discord', author: { kind: 'discord', id: `discord:${USER}`, name: 'Brother' }, sourceId: `${CHANNEL}:52345678901234567` });
    await f.bridge.stop();
    const restarted = new DiscordWorkspaceBridge(f.options); bridges.push(restarted);
    expect((await restarted.status()).state).toBe('off');
    await restarted.start(); f.handlers().onMessage(f.message());
    await vi.waitFor(async () => { expect((await restarted.status()).receivedCount).toBe(1); });
    expect(await f.entries()).toHaveLength(1);
    expect(f.sends()).toHaveLength(0); // Discord-origin entries are never echoed back.
  });

  it('sends the first local message with explicit human/agent attribution and suppresses mentions and restart duplicates', async () => {
    const f = await fixture(); await f.bridge.configure(f.input); await f.bridge.start();
    await f.workspace.act({ action: A.POST, target: f.room.id, input: { body: 'First local message @everyone' } });
    await vi.waitFor(() => { expect(f.sends()).toHaveLength(1); });
    const send = f.sends()[0]!.body!;
    expect(send['content']).toContain('You (human)'); expect(send['content']).toContain('First local message');
    expect(send['allowed_mentions']).toEqual({ parse: [], users: [], roles: [] });
    expect(send['nonce']).toMatch(/^[a-f0-9]{24}$/u); expect(send['enforce_nonce']).toBe(true);
    await f.bridge.stop(); const restarted = new DiscordWorkspaceBridge(f.options); bridges.push(restarted);
    expect((await restarted.status()).state).toBe('off'); await restarted.start();
    await new Promise(done => setTimeout(done, 40)); expect(f.sends()).toHaveLength(1);
    await restarted.disconnect(); expect((await restarted.status()).configured).toBe(false);
    await expect(readFile(join(f.directory, 'discord-workspaces.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not send history existing before the owner selected this connection', async () => {
    const f = await fixture(); await f.workspace.act({ action: A.POST, target: f.room.id, input: { body: 'Private earlier history' } });
    await f.bridge.configure(f.input); await f.bridge.start(); await new Promise(done => setTimeout(done, 40));
    expect(f.sends()).toHaveLength(0);
  });

  it('drains every earliest unsent page after a pause without skipping or duplicating messages', async () => {
    const f = await fixture(); await f.bridge.configure(f.input);
    const bodies = Array.from({ length: 65 }, (_, index) => `Message while Discord was paused: ${index}`);
    for (const body of bodies) await f.workspace.act({ action: A.POST, target: f.room.id, input: { body } });
    await f.bridge.start();
    await vi.waitFor(async () => { expect((await f.bridge.status()).sentCount).toBe(bodies.length); }, { timeout: 5_000 });
    expect(f.sends().map(request => request.body!['content'])).toEqual(bodies.map(body => `You (human)\n${body}`));
    expect(new Set(f.sends().map(request => request.body!['nonce'])).size).toBe(bodies.length);
    await f.bridge.stop(); const restarted = new DiscordWorkspaceBridge(f.options); bridges.push(restarted);
    await restarted.start(); await new Promise(done => setTimeout(done, 40));
    expect(f.sends()).toHaveLength(bodies.length);
  });

  it('does not commit a startup invitation that was queued before Pause', async () => {
    const f = await fixture(); await f.bridge.configure(f.input);
    let entered!: () => void; const reached = new Promise<void>(done => { entered = done; });
    let release!: () => void; const gate = new Promise<void>(done => { release = done; });
    const bridge = new DiscordWorkspaceBridge({ ...f.options, workspaces: {
      status: principal => f.workspace.status(principal),
      act: async (request, principal, ownerAuthorize) => {
        if (request.action === A.INVITE) { entered(); await gate; }
        return f.workspace.act(request, principal, ownerAuthorize);
      },
    } }); bridges.push(bridge);
    const starting = bridge.start(); await reached;
    await bridge.stop(); release(); expect((await starting).state).toBe('off');
    const current = (await f.workspace.act({ action: A.READ, target: f.room.id })).workspace!;
    expect(current.members.some(member => member.kind === 'discord')).toBe(false);
    expect(f.connects()).toBe(0);
  });

  it('pauses on failed delivery, preserves local messages and prevents events after Pause or membership revocation', async () => {
    const f = await fixture(); await f.bridge.configure(f.input); await f.bridge.start();
    await f.bridge.stop(); f.handlers().onMessage(f.message()); await new Promise(done => setTimeout(done, 20)); expect(await f.entries()).toHaveLength(0);
    await f.bridge.start();
    const room = (await f.workspace.act({ action: A.READ, target: f.room.id })).workspace!;
    const revoke = (await f.workspace.act({ action: A.READ, target: f.room.id })).affordances.find(control => control.action === A.REVOKE && control.target.includes(encodeURIComponent(room.members.find(member => member.kind === 'discord')!.id)))!;
    await f.workspace.act({ action: revoke.action, target: revoke.target }); f.handlers().onMessage(f.message());
    await vi.waitFor(async () => { expect((await f.bridge.status()).state).toBe('error'); }); expect(await f.entries()).toHaveLength(0);
    const noReadmit = await f.bridge.start(); expect(noReadmit.state).toBe('error');
    // A failed HTTP delivery also leaves the local record intact and stops further sends.
    const other = await fixture(); await other.bridge.configure(other.input); await other.bridge.start(); other.failSend(true);
    await other.workspace.act({ action: A.POST, target: other.room.id, input: { body: 'Saved locally despite delivery error' } });
    await vi.waitFor(async () => { expect((await other.bridge.status()).state).toBe('error'); }); expect(await other.entries()).toHaveLength(1);
  });
});
