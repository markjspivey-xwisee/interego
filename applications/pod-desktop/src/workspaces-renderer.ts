import type { DesktopApi, PodStatus } from './types.js';
import { WORKSPACE_ACTIONS as A, type WorkspaceAffordance, type WorkspaceRepresentation, type WorkspaceSummary } from './workspace-types.js';

export function installWorkspacesUi(api: DesktopApi, context: { pod(): PodStatus | null; busy(): boolean }) {
  const element = <T extends HTMLElement = HTMLElement>(id: string): T => {
    const found = document.getElementById(id);
    if (!found) throw new Error(`Missing workspace control: ${id}`);
    return found as T;
  };
  const input = (id: string) => element<HTMLInputElement>(id);
  const button = (id: string) => element<HTMLButtonElement>(id);
  let collection: WorkspaceRepresentation | undefined;
  let room: WorkspaceRepresentation | undefined;
  let occupied = false;
  let reading = false;
  let epoch = 0;
  let visible = false;
  let lastReadInput: Record<string, unknown> = {};
  let grantIds = new Map<string, { name: string; chat: boolean }>();
  function errorText(error: unknown, fallback: string): string {
    // IPC errors may originate in the isolated preload's JavaScript realm.
    const message = error && typeof error === 'object' ? (error as { message?: unknown }).message : undefined;
    return typeof message === 'string' && message.length <= 1000 ? message : fallback;
  }
  const operation = (representation: WorkspaceRepresentation | undefined, action: string, target?: string): WorkspaceAffordance | undefined =>
    representation?.affordances.find(value => value.action === action && (!target || value.target === target));
  function feedback(message: string, error = false): void {
    const region = element('workspace-feedback'); region.hidden = !message;
    region.textContent = message; region.classList.toggle('workspace-error', error);
    region.setAttribute('role', error ? 'alert' : 'status');
  }
  async function follow(advertised: WorkspaceAffordance | undefined, values: Record<string, unknown> = {}): Promise<WorkspaceRepresentation> {
    if (!advertised) throw new Error('That action is no longer available. Refresh Workspaces and try again.');
    return api.workspaceAct({ action: advertised.action, target: advertised.target, input: values });
  }
  function availability(): void {
    const running = !!context.pod()?.running;
    for (const control of Array.from(element('workspaces-page').querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement | HTMLTextAreaElement>('input,button,select,textarea'))) {
      control.disabled = occupied || context.busy() || !running;
    }
    button('workspace-send').disabled ||= !operation(room, A.POST);
    button('workspace-invite-button').disabled ||= !operation(room, A.INVITE) || !grantIds.size;
    button('workspace-earlier').disabled ||= !room?.page?.hasEarlier;
    button('workspace-later').disabled ||= !room?.page?.hasLater;
    for (const id of ['workspace-discord-stop', 'workspace-discord-forget']) button(id).disabled = occupied || context.busy();
  }
  async function run(task: () => Promise<void>, allowStopped = false): Promise<void> {
    if (occupied || context.busy() || !allowStopped && !context.pod()?.running) return;
    occupied = true; epoch++; feedback(''); availability();
    try { await task(); }
    catch (error) { feedback(errorText(error, 'This workspace action could not be completed. Refresh and try again.'), true); }
    finally { occupied = false; availability(); }
  }
  function acceptView(value: WorkspaceRepresentation): void {
    if (value.workspace) room = value;
    else { collection = value; if (!value.enabled) room = undefined; }
    draw();
  }
  function draw(): void {
    const enabled = !!collection?.enabled;
    element('workspaces-page').classList.toggle('workspace-enabled', enabled);
    element('workspace-state').textContent = !context.pod()?.running ? 'Start Interego to use your local workspaces.'
      : !collection ? 'Checking Workspaces…' : enabled ? 'Workspaces are on. Conversations are saved here; agents and Discord need your permission.'
        : 'Workspaces are optional. Enable them to start a conversation on this computer.';
    button('workspace-enable').hidden = !operation(collection, A.ENABLE);
    button('workspace-disable').hidden = !operation(collection, A.DISABLE);
    element('workspace-content').hidden = !enabled;
    element('workspace-discord').hidden = !enabled;
    const list = element('workspace-list'); list.replaceChildren();
    const choices = element<HTMLSelectElement>('workspace-discord-room');
    const chosen = choices.value; choices.replaceChildren();
    for (const workspace of collection?.workspaces ?? []) {
      const open = document.createElement('button'); open.type = 'button'; open.className = 'secondary';
      open.textContent = `${workspace.title} · ${workspace.entryCount}`;
      open.setAttribute('aria-label', `Open workspace ${workspace.title}`);
      open.addEventListener('click', () => { void run(async () => {
        lastReadInput = {};
        acceptView(await follow(operation(collection, A.READ, workspace.id)));
        await loadParticipants();
      }); });
      list.append(open);
      const option = document.createElement('option'); option.value = workspace.id; option.textContent = workspace.title; choices.append(option);
    }
    if (Array.from(choices.options).some(option => option.value === chosen)) choices.value = chosen;
    element('workspace-selected').hidden = !room?.workspace || !enabled;
    element('workspace-empty').hidden = !!room?.workspace;
    const conversation = room?.workspace;
    if (conversation) {
      element('workspace-room-title').textContent = conversation.title;
      element('workspace-room-count').textContent = room?.page?.startSeq !== null && room?.page?.startSeq !== undefined
        ? `${conversation.entryCount} messages · ${room.page.startSeq + 1}–${room.page.endSeq! + 1}` : String(conversation.entryCount);
      const messages = element('workspace-messages'); const atEnd = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 80;
      messages.replaceChildren();
      for (const entry of conversation.entries) {
        const article = document.createElement('article'); article.className = 'workspace-message';
        const author = document.createElement('strong'); author.textContent = `${entry.author.name}${entry.author.kind === 'agent' ? ' · Agent' : entry.author.kind === 'discord' ? ' · Discord' : ''}`;
        const body = document.createElement('p'); body.textContent = entry.body;
        const date = document.createElement('small'); date.textContent = new Date(entry.createdAt).toLocaleString();
        article.append(author, body, date); messages.append(article);
      }
      if (atEnd) messages.scrollTop = messages.scrollHeight;
      const members = element('workspace-members'); members.replaceChildren();
      for (const member of conversation.members) {
        const row = document.createElement('div'); row.className = 'workspace-member';
        const label = document.createElement('span'); label.textContent = `${member.name} · ${member.kind} · ${member.state}`; row.append(label);
        const revoke = room?.affordances.find(value => value.action === A.REVOKE && value.target.endsWith(`:member:${encodeURIComponent(member.id)}`));
        if (revoke) { const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'danger'; remove.textContent = 'Remove';
          remove.setAttribute('aria-label', `Remove ${member.name} from this workspace`);
          remove.addEventListener('click', () => { void run(async () => { acceptView(await follow(revoke)); await reloadCollection(); feedback('This participant can no longer read or post through this workspace.'); }); }); row.append(remove); }
        members.append(row);
      }
    }
    availability();
  }
  async function reloadCollection(): Promise<void> {
    const value = await api.workspaceStatus(); collection = value; if (!value.enabled) room = undefined; draw();
  }
  async function loadParticipants(): Promise<void> {
    const selector = element<HTMLSelectElement>('workspace-invite-agent'); const chosen = selector.value;
    selector.replaceChildren(); grantIds = new Map();
    const active = room?.workspace;
    if (active) for (const connection of await api.connections()) {
      if (!['waiting', 'active'].includes(connection.state) || !connection.workspaceIds?.includes(active.id)
        || !connection.permissions.some(value => value.startsWith('workspaces:'))
        || active.members.some(member => member.id === connection.id && ['active', 'invited'].includes(member.state))) continue;
      grantIds.set(connection.id, { name: connection.name, chat: connection.permissions.includes('workspaces:chat') });
      const option = document.createElement('option'); option.value = connection.id; option.textContent = connection.name; selector.append(option);
    }
    if (!grantIds.size) { const option = document.createElement('option'); option.value = ''; option.textContent = 'Connect an app with access to this workspace first'; selector.append(option); }
    else if (grantIds.has(chosen)) selector.value = chosen;
    availability();
  }
  async function refresh(): Promise<void> {
    if (!visible || occupied || reading) return;
    if (!context.pod()?.running) { draw(); return; }
    reading = true; const requested = epoch;
    try {
      const next = await api.workspaceStatus();
      if (requested !== epoch) return;
      collection = next;
      if (room?.workspace && next.enabled) {
        const read = operation(next, A.READ, room.workspace.id);
        const refreshed = read ? await follow(read, lastReadInput) : undefined;
        if (requested !== epoch) return; room = refreshed;
      } else if (!next.enabled) room = undefined;
      draw(); await loadParticipants(); await refreshDiscord();
    } catch (error) { if (requested === epoch) feedback(errorText(error, 'Workspaces could not be read. Refresh to try again.'), true); }
    finally { reading = false; }
  }
  async function refreshDiscord(): Promise<void> {
    const status = await api.discordWorkspaceStatus();
    const connecting = status.state === 'connecting';
    element('workspace-discord-status').textContent = `${connecting ? 'Connecting…' : status.running ? 'Connected' : status.configured ? 'Saved and paused' : 'Not configured'} · ${status.receivedCount} received · ${status.sentCount} sent${status.lastError ? ` · ${status.lastError}` : ''}. ${status.disclosure}`;
    button('workspace-discord-start').hidden = !status.configured || status.running || connecting;
    button('workspace-discord-stop').hidden = !status.running && !connecting;
    button('workspace-discord-forget').hidden = !status.configured;
    if (status.configured && !document.activeElement?.closest('#workspace-discord-form')) {
      if (status.workspaceId) element<HTMLSelectElement>('workspace-discord-room').value = status.workspaceId;
      if (status.channelId) input('workspace-discord-channel').value = status.channelId;
      element<HTMLTextAreaElement>('workspace-discord-people').value = status.participants.map(person => `${person.discordUserId} | ${person.name}`).join('\n');
    }
  }
  button('workspace-enable').addEventListener('click', () => { void run(async () => { acceptView(await follow(operation(collection, A.ENABLE))); }); });
  button('workspace-disable').addEventListener('click', () => { void run(async () => { acceptView(await follow(operation(collection, A.DISABLE))); }); });
  button('workspace-refresh').addEventListener('click', () => { void refresh(); });
  element<HTMLFormElement>('workspace-create').addEventListener('submit', event => {
    event.preventDefault(); const title = input('workspace-title').value.trim();
    void run(async () => { const created = await follow(operation(collection, A.CREATE), { title }); acceptView(created); input('workspace-title').value = ''; await reloadCollection(); await loadParticipants(); });
  });
  element<HTMLFormElement>('workspace-post').addEventListener('submit', event => {
    event.preventDefault(); const body = element<HTMLTextAreaElement>('workspace-body').value;
    void run(async () => { lastReadInput = {}; acceptView(await follow(operation(room, A.POST), { body })); element<HTMLTextAreaElement>('workspace-body').value = ''; await reloadCollection(); });
  });
  for (const [id, direction] of [['workspace-earlier', 'earlier'], ['workspace-later', 'later'], ['workspace-latest', 'latest']] as const) {
    button(id).addEventListener('click', () => { void run(async () => {
      const page = room?.page; const selected = room?.workspace?.id;
      if (!selected || !page) return;
      lastReadInput = direction === 'earlier' ? { beforeSeq: page.startSeq } : direction === 'later' ? { afterSeq: page.endSeq } : {};
      acceptView(await follow(operation(room, A.READ, selected), lastReadInput));
    }); });
  }
  element<HTMLFormElement>('workspace-invite').addEventListener('submit', event => {
    event.preventDefault(); const memberId = element<HTMLSelectElement>('workspace-invite-agent').value; const grant = grantIds.get(memberId);
    if (grant) void run(async () => { acceptView(await follow(operation(room, A.INVITE), { memberId, name: grant.name, kind: 'agent', role: grant.chat ? 'contributor' : 'reader' })); await loadParticipants(); feedback('Invitation saved. Ask the agent to discover Interego and accept its workspace invitation.'); });
  });
  element<HTMLFormElement>('workspace-discord-form').addEventListener('submit', event => {
    event.preventDefault();
    void run(async () => {
      const token = input('workspace-discord-token').value;
      const consent = input('workspace-discord-consent').checked as true;
      input('workspace-discord-token').value = ''; input('workspace-discord-consent').checked = false;
      const rawChannel = input('workspace-discord-channel').value.trim();
      const channelId = /^https:\/\/discord\.com\/channels\/\d+\/(\d+)\/?$/.exec(rawChannel)?.[1] ?? rawChannel;
      const participants = element<HTMLTextAreaElement>('workspace-discord-people').value.split(/\r?\n/).filter(value => value.trim()).map(value => {
        const parts = value.split('|'); if (parts.length !== 2 || !parts[1]?.trim()) throw new Error('Use one person per line: Discord user ID | Display name.');
        return { discordUserId: parts[0]!.trim().replace(/^<@!?(\d+)>$/, '$1'), name: parts[1]!.trim() };
      });
      await api.configureDiscordWorkspace({ workspaceId: element<HTMLSelectElement>('workspace-discord-room').value,
        channelId, token, participants, consent });
      await refreshDiscord(); feedback('Discord setup saved. Choose Start Discord bridge when you are ready to share messages.');
    });
  });
  for (const [id, perform] of [['workspace-discord-start', () => api.startDiscordWorkspace()], ['workspace-discord-stop', () => api.stopDiscordWorkspace()], ['workspace-discord-forget', () => api.disconnectDiscordWorkspace()]] as const) {
    button(id).addEventListener('click', () => { void run(async () => { await perform(); await refreshDiscord(); }, id !== 'workspace-discord-start'); });
  }
  button('workspace-discord-help').addEventListener('click', () => { void api.openDiscordWorkspaceSetup().catch(() => feedback('Discord setup could not open. Try again.', true)); });
  return { refresh, updateAvailability: availability, show(active: boolean) { visible = active; if (active) void refresh(); },
    async choices(): Promise<readonly WorkspaceSummary[]> { if (!context.pod()?.running) return []; return (await api.workspaceStatus()).workspaces ?? []; } };
}
