/** Optional Discord projection of one explicitly selected local workspace. No network on load. */
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { WebSocket } from 'ws';
import { DiscordGateway, type GatewayHandlers, type GatewayMessage } from '../../shared-workspace/discord/src/discord.js';
import type { AgentProtector } from './agent-types.js';
import { WORKSPACE_ACTIONS, WORKSPACE_ID_PATTERN, type WorkspaceActRequest, type WorkspacePrincipal, type WorkspaceRepresentation } from './workspace-types.js';

export interface DiscordWorkspaceParticipant { readonly discordUserId: string; readonly name: string }
export interface DiscordWorkspaceInput {
  readonly workspaceId: string;
  readonly channelId: string;
  readonly token: string;
  readonly participants: readonly DiscordWorkspaceParticipant[];
  readonly consent: true;
}
export type DiscordWorkspaceConfiguration = DiscordWorkspaceInput;
export interface DiscordWorkspaceStatus {
  readonly configured: boolean;
  readonly running: boolean;
  readonly state: 'off' | 'connecting' | 'running' | 'error';
  readonly workspaceId?: string;
  readonly channelId?: string;
  readonly participants: readonly DiscordWorkspaceParticipant[];
  readonly receivedCount: number;
  readonly sentCount: number;
  readonly lastError?: string;
  readonly disclosure: string;
}
interface WorkspacePort {
  status(principal?: WorkspacePrincipal): Promise<WorkspaceRepresentation>;
  act(request: WorkspaceActRequest, principal?: WorkspacePrincipal, ownerAuthorize?: () => Promise<void>): Promise<WorkspaceRepresentation>;
}
export interface DiscordWorkspaceOptions {
  readonly dataDir: string;
  readonly protector: AgentProtector;
  readonly workspaces: WorkspacePort;
  readonly fetch?: typeof fetch;
  readonly openSocket?: (url: string) => WebSocket;
  /** Injected only by isolated tests; production uses the retained Discord gateway implementation. */
  readonly gateway?: (token: string, handlers: GatewayHandlers, openSocket: (url: string) => WebSocket) => { connect(): void; stop(): void };
  readonly pollMs?: number;
}
interface Saved { readonly version: 1; readonly configuration: Omit<DiscordWorkspaceInput, 'consent'>; readonly lastSentSeq: number }
const SNOWFLAKE = /^[0-9]{17,20}$/;
const DISCLOSURE = 'Only this workspace and Discord channel are connected. Allowed Discord participants are shown by their Discord identity; they are not authenticated as your local identity. New workspace messages, including messages saved while paused, can be sent to Discord and its channel members. Discord can read them. Files, edits and deletions are not synchronized. Agents need a separate scoped connection and their provider may receive messages they read. Closing Interego pauses access; every launch starts off.';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Discord settings could not be read.');
  return value as Record<string, unknown>;
}
function validated(raw: unknown): Omit<DiscordWorkspaceInput, 'consent'> {
  const value = object(raw);
  if (Object.keys(value).some(key => !['workspaceId', 'channelId', 'token', 'participants', 'consent'].includes(key))
    || typeof value['workspaceId'] !== 'string' || !WORKSPACE_ID_PATTERN.test(value['workspaceId'])
    || typeof value['channelId'] !== 'string' || !SNOWFLAKE.test(value['channelId'])
    || typeof value['token'] !== 'string' || value['token'].length < 20 || value['token'].length > 256 || /\s/u.test(value['token'])
    || !Array.isArray(value['participants']) || !value['participants'].length || value['participants'].length > 20) throw new Error('Choose a workspace, channel, bot token and allowed Discord participants.');
  const participants = value['participants'].map(rawParticipant => {
    const participant = object(rawParticipant);
    if (Object.keys(participant).sort().join(',') !== 'discordUserId,name' || typeof participant['discordUserId'] !== 'string' || !SNOWFLAKE.test(participant['discordUserId'])
      || typeof participant['name'] !== 'string' || !participant['name'].trim() || participant['name'].length > 80 || /[\u0000-\u001f\u007f]/u.test(participant['name'])) throw new Error('Add each allowed Discord user ID and display name.');
    return { discordUserId: participant['discordUserId'], name: participant['name'].trim() };
  });
  if (new Set(participants.map(participant => participant.discordUserId)).size !== participants.length) throw new Error('Choose each Discord participant once.');
  return { workspaceId: value['workspaceId'], channelId: value['channelId'], token: value['token'], participants };
}

export class DiscordWorkspaceBridge {
  private readonly path: string;
  private ready: Promise<void> | undefined;
  private saved: Saved | undefined;
  private state: DiscordWorkspaceStatus['state'] = 'off';
  private error: string | undefined;
  private gateway: { connect(): void; stop(): void } | undefined;
  private lifetime: AbortController | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private epoch = 0;
  private tasks: Promise<unknown> = Promise.resolve();
  private received = 0;
  private sent = 0;
  private readonly incoming = new Set<string>();

  constructor(private readonly options: DiscordWorkspaceOptions) {
    if (!isAbsolute(options.dataDir)) throw new Error('Discord needs a dedicated local data folder.');
    this.path = join(options.dataDir, 'discord-workspaces.json');
  }

  private async load(): Promise<void> {
    this.ready ??= (async () => {
      await mkdir(this.options.dataDir, { recursive: true, mode: 0o700 });
      const directory = await lstat(this.options.dataDir);
      if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('Discord settings need a regular local folder.');
      let metadata;
      try { metadata = await lstat(this.path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 128 * 1024) throw new Error('Discord settings could not be read.');
      const file = await open(this.path, 'r');
      try {
        const current = await file.stat();
        if (current.dev !== metadata.dev || current.ino !== metadata.ino || current.size > 128 * 1024) throw new Error('Discord settings changed while opening.');
        const bytes = Buffer.alloc(128 * 1024 + 1); const read = await file.read(bytes, 0, bytes.length, 0);
        if (read.bytesRead > 128 * 1024) throw new Error('Discord settings are too large.');
        const wrapper = object(JSON.parse(bytes.subarray(0, read.bytesRead).toString('utf8')));
        if (Object.keys(wrapper).sort().join(',') !== 'ciphertext,version' || wrapper['version'] !== 1 || typeof wrapper['ciphertext'] !== 'string') throw new Error('Discord settings could not be read.');
        const saved = object(JSON.parse(this.options.protector.unprotect(wrapper['ciphertext'])));
        if (Object.keys(saved).sort().join(',') !== 'configuration,lastSentSeq,version' || saved['version'] !== 1 || !Number.isSafeInteger(saved['lastSentSeq']) || Number(saved['lastSentSeq']) < -1) throw new Error('Discord settings could not be read.');
        this.saved = { version: 1, configuration: validated(saved['configuration']), lastSentSeq: Number(saved['lastSentSeq']) };
      } finally { await file.close(); }
    })();
    return this.ready;
  }

  private async save(value: Saved): Promise<void> {
    const temporary = join(this.options.dataDir, `.discord-${randomUUID()}.tmp`);
    const file = await open(temporary, 'wx', 0o600);
    try {
      try { await file.writeFile(JSON.stringify({ version: 1, ciphertext: this.options.protector.protect(JSON.stringify(value)) })); await file.sync(); }
      finally { await file.close(); }
      await rename(temporary, this.path); this.saved = value;
    } finally { await unlink(temporary).catch(() => {}); }
  }

  async status(): Promise<DiscordWorkspaceStatus> {
    await this.load();
    const config = this.saved?.configuration;
    return { configured: Boolean(config), running: this.state === 'running', state: this.state,
      ...(config ? { workspaceId: config.workspaceId, channelId: config.channelId } : {}),
      participants: config?.participants.map(participant => ({ ...participant })) ?? [], receivedCount: this.received, sentCount: this.sent,
      ...(this.error ? { lastError: this.error } : {}), disclosure: DISCLOSURE };
  }

  private async follow(action: string, target: string, input?: Readonly<Record<string, unknown>>, principal?: WorkspacePrincipal, ownerAuthorize?: () => Promise<void>): Promise<WorkspaceRepresentation> {
    const representation = await this.options.workspaces.status(principal);
    await ownerAuthorize?.();
    // Acceptance targets the invitation resource advertised by the selected principal's view.
    // It is deliberately not reconstructed from a membership filename convention.
    let affordance = representation.affordances.find(control => control.action === action && (control.target === target || action === WORKSPACE_ACTIONS.ACCEPT));
    if (!affordance && action !== WORKSPACE_ACTIONS.READ) {
      const read = representation.affordances.find(control => control.action === WORKSPACE_ACTIONS.READ && control.target === target);
      if (read) {
        const workspace = await this.options.workspaces.act({ action: read.action, target: read.target }, principal, ownerAuthorize);
        affordance = workspace.affordances.find(control => control.action === action && control.target === target);
      }
    }
    if (!affordance) throw new Error('This workspace action is unavailable. Review membership and sharing in Workspaces.');
    return this.options.workspaces.act({ action: affordance.action, target: affordance.target, ...(input ? { input } : {}) }, principal, ownerAuthorize);
  }

  async configure(input: DiscordWorkspaceInput): Promise<DiscordWorkspaceStatus> {
    if (object(input)['consent'] !== true) throw new Error('Confirm sharing this workspace with Discord before saving.');
    const configuration = validated(input);
    await this.stop();
    const workspace = await this.follow(WORKSPACE_ACTIONS.READ, configuration.workspaceId);
    if (!workspace.workspace) throw new Error('Choose an available workspace.');
    // The representation may contain a bounded page. Baseline the complete conversation,
    // rather than the last entry of a page, so earlier private history is never projected.
    const lastSentSeq = workspace.workspace.entryCount - 1;
    await this.save({ version: 1, configuration, lastSentSeq });
    this.error = undefined; this.incoming.clear();
    return this.status();
  }

  private guard(epoch: number): void {
    if (epoch !== this.epoch || !this.lifetime || this.lifetime.signal.aborted || !['connecting', 'running'].includes(this.state)) throw new Error('Discord is paused.');
  }

  private principal(participant: DiscordWorkspaceParticipant, epoch: number): WorkspacePrincipal {
    return { kind: 'discord', id: `discord:${participant.discordUserId}`, name: participant.name,
      permissions: ['workspaces:read', 'workspaces:chat'], workspaceIds: [this.saved!.configuration.workspaceId],
      authorize: async () => {
        this.guard(epoch);
        if (!this.saved?.configuration.participants.some(allowed => allowed.discordUserId === participant.discordUserId)) throw new Error('This Discord participant is not allowed.');
      } };
  }

  private async api(path: string, method: 'GET' | 'POST', epoch: number, body?: unknown): Promise<Record<string, unknown>> {
    this.guard(epoch);
    if (!/^\/(?:users\/@me|channels\/[0-9]{17,20}(?:\/messages)?)$/u.test(path)) throw new Error('Unsupported Discord destination.');
    const response = await (this.options.fetch ?? fetch)(`https://discord.com/api/v10${path}`, {
      method, redirect: 'error', signal: AbortSignal.any([this.lifetime!.signal, AbortSignal.timeout(20_000)]),
      headers: { authorization: `Bot ${this.saved!.configuration.token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    this.guard(epoch);
    if (!response.ok) throw new Error('Discord could not complete the request. Check the bot token, channel permissions and Message Content intent.');
    const text = await response.text();
    this.guard(epoch);
    if (text.length > 256 * 1024) throw new Error('Discord returned an oversized response.');
    return object(JSON.parse(text));
  }

  async start(): Promise<DiscordWorkspaceStatus> {
    await this.stop();
    if (!this.saved) throw new Error('Save a Discord connection first.');
    const epoch = ++this.epoch;
    this.lifetime = new AbortController(); this.state = 'connecting'; this.error = undefined;
    try {
      const config = this.saved.configuration;
      const ownerAuthorize = async () => { this.guard(epoch); };
      const current = await this.follow(WORKSPACE_ACTIONS.READ, config.workspaceId, undefined, undefined, ownerAuthorize);
      this.guard(epoch);
      if (!current.workspace) throw new Error('The selected workspace is unavailable.');
      await this.api('/users/@me', 'GET', epoch);
      const channel = await this.api(`/channels/${config.channelId}`, 'GET', epoch);
      if (channel['id'] !== config.channelId || ![0, 5, 10, 11, 12].includes(Number(channel['type']))) throw new Error('Choose a Discord text channel or thread the bot can access.');
      for (const participant of config.participants) {
        const member = current.workspace.members.find(candidate => candidate.id === `discord:${participant.discordUserId}`);
        if (member && ['left', 'revoked'].includes(member.state)) {
          this.error = 'A selected Discord participant left or was removed. Invite them again in Workspaces before connecting.';
          throw new Error('Discord membership requires a new owner invitation.');
        }
        if (!member) {
          await this.follow(WORKSPACE_ACTIONS.INVITE, config.workspaceId, { memberId: `discord:${participant.discordUserId}`, name: participant.name, kind: 'discord', role: 'contributor' }, undefined, ownerAuthorize);
        }
        this.guard(epoch);
        if (member?.state !== 'active') await this.follow(WORKSPACE_ACTIONS.ACCEPT, config.workspaceId, undefined, this.principal(participant, epoch));
      }
      const handlers: GatewayHandlers = {
        onMessage: message => { this.enqueue(() => this.receive(message, epoch), epoch); },
        onInteraction: () => {}, onAutocomplete: () => {}, onModalSubmit: () => {},
        onNotice: notice => { if (epoch === this.epoch && /gateway ready|gateway resumed/u.test(notice)) this.state = 'running'; },
        onFatal: () => { if (epoch === this.epoch) { this.error = 'Discord disconnected. Check its bot permissions and Message Content intent, then start again.'; this.pause('error'); } },
      };
      const socket = (value: string): WebSocket => {
        this.guard(epoch);
        const url = new URL(value);
        if (url.protocol !== 'wss:' || url.port || url.username || url.password || !(url.hostname === 'gateway.discord.gg' || /^gateway-[a-z0-9-]+\.discord\.gg$/u.test(url.hostname))) throw new Error('Discord gateway destination refused.');
        return this.options.openSocket ? this.options.openSocket(value) : new WebSocket(value, { followRedirects: false });
      };
      this.gateway = this.options.gateway?.(config.token, handlers, socket) ?? new DiscordGateway(config.token, handlers, socket);
      this.gateway.connect();
      this.timer = setInterval(() => { this.enqueue(() => this.sendNew(epoch), epoch); }, this.options.pollMs ?? 4_000); this.timer.unref?.();
      this.enqueue(() => this.sendNew(epoch), epoch);
      return this.status();
    } catch {
      if (epoch === this.epoch) { this.error ??= 'Discord could not start. Check the selected workspace, bot token, allowed participants and channel permissions.'; this.pause('error'); }
      return this.status();
    }
  }

  private enqueue(task: () => Promise<void>, epoch: number): void {
    this.tasks = this.tasks.then(async () => { this.guard(epoch); await task(); }).catch(() => {
      if (epoch === this.epoch) { this.error = 'Discord delivery paused after an error. Your local messages remain saved. Check the channel for partial delivery before starting again.'; this.pause('error'); }
    });
  }

  private async receive(message: GatewayMessage, epoch: number): Promise<void> {
    this.guard(epoch);
    const config = this.saved!.configuration;
    if (message.authorBot || message.channelId !== config.channelId || !message.content.trim()) return;
    const participant = config.participants.find(candidate => candidate.discordUserId === message.authorId);
    if (!participant || !SNOWFLAKE.test(message.id)) return;
    const sourceId = `${config.channelId}:${message.id}`;
    if (this.incoming.has(sourceId)) return;
    const principal = this.principal(participant, epoch);
    await this.follow(WORKSPACE_ACTIONS.POST, config.workspaceId, { body: message.content, sourceId }, principal);
    this.guard(epoch);
    this.incoming.add(sourceId); if (this.incoming.size > 1_000) this.incoming.delete(this.incoming.values().next().value!);
    this.received++;
  }

  private async sendNew(epoch: number): Promise<void> {
    this.guard(epoch);
    const selected = this.saved!;
    // Read the EARLIEST unsent page. Reading the default latest page would skip a gap when
    // more entries arrived while this bridge was paused than fit in one representation.
    const representation = await this.follow(WORKSPACE_ACTIONS.READ, selected.configuration.workspaceId,
      { afterSeq: selected.lastSentSeq, limit: 20 }, undefined, async () => { this.guard(epoch); });
    this.guard(epoch);
    if (!representation.workspace) throw new Error('Workspace unavailable.');
    for (const entry of representation.workspace.entries.filter(candidate => candidate.seq > this.saved!.lastSentSeq).sort((a, b) => a.seq - b.seq)) {
      this.guard(epoch);
      if (entry.author.kind !== 'discord') {
        const content = `${entry.author.name} (${entry.author.kind})\n${entry.body}`;
        const parts = content.match(/[\s\S]{1,1800}/gu) ?? [];
        for (let index = 0; index < parts.length; index++) {
          const nonce = createHash('sha256').update(`${selected.configuration.channelId}:${entry.id}:${index}`).digest('hex').slice(0, 24);
          await this.api(`/channels/${selected.configuration.channelId}/messages`, 'POST', epoch, {
            content: parts.length > 1 ? `(${index + 1}/${parts.length}) ${parts[index]}` : parts[index], allowed_mentions: { parse: [], users: [], roles: [] }, nonce, enforce_nonce: true,
          });
        }
        this.sent++;
      }
      this.guard(epoch);
      await this.save({ ...this.saved!, lastSentSeq: entry.seq });
      this.guard(epoch);
    }
  }

  private pause(state: DiscordWorkspaceStatus['state'] = 'off'): void {
    this.epoch++; this.lifetime?.abort(); this.lifetime = undefined;
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    this.gateway?.stop(); this.gateway = undefined; this.state = state;
  }

  async stop(): Promise<DiscordWorkspaceStatus> {
    this.pause(); await this.tasks; await this.load(); return this.status();
  }

  async disconnect(): Promise<DiscordWorkspaceStatus> {
    await this.stop(); await unlink(this.path).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
    this.saved = undefined; this.incoming.clear(); this.error = undefined; return this.status();
  }
}
