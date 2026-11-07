/** Isolated packaged verification of the optional vertical and real agent companion. */
import { Peer } from './pairing-smoke.js';
import type { AgentConnection, AgentConnectionInput } from './agent-types.js';
import type { LocalNote } from './types.js';
import { WORKSPACE_ACTIONS as A, type WorkspaceRepresentation } from './workspace-types.js';

interface Options {
  readonly invoke: <T>(method: string, value?: unknown) => Promise<T>;
  readonly command: string;
  readonly args: readonly string[];
  readonly userData: string;
  readonly packaged: boolean;
  readonly expectPrevious: boolean;
  readonly create: (input: AgentConnectionInput) => Promise<AgentConnection>;
  readonly revoke: (id: string) => Promise<void>;
  readonly list: () => Promise<readonly AgentConnection[]>;
  readonly notes: () => Promise<readonly LocalNote[]>;
}

function toolResult(value: unknown): WorkspaceRepresentation {
  const result = value as { isError?: boolean; structuredContent?: WorkspaceRepresentation; content?: { type: string; text?: string }[] };
  if (result.isError) throw new Error('The packaged workspace companion refused an allowed action.');
  return result.structuredContent ?? JSON.parse(result.content?.find(row => row.type === 'text')?.text ?? 'null') as WorkspaceRepresentation;
}

export async function verifyWorkspaces(options: Options): Promise<void> {
  let root = await options.invoke<WorkspaceRepresentation>('workspaceStatus');
  if (root.enabled || !root.localOnly || root.federationEnabled) throw new Error('Packaged Workspaces must begin off, without federation.');
  async function owner(view: WorkspaceRepresentation, action: string, input: Record<string, unknown> = {}, target?: string) {
    const advertised = view.affordances.find(candidate => candidate.action === action && (!target || target === candidate.target));
    if (!advertised) throw new Error('A packaged workspace owner action was not advertised.');
    return options.invoke<WorkspaceRepresentation>('workspaceAct', { action: advertised.action, target: advertised.target, input });
  }
  root = await owner(root, A.ENABLE);
  const title = 'Packaged workspace verification';
  let view: WorkspaceRepresentation;
  if (options.expectPrevious) {
    const existing = root.workspaces?.find(candidate => candidate.title === title);
    if (!existing) throw new Error('Packaged workspace data did not survive quitting.');
    view = await owner(root, A.READ, {}, existing.id);
    if (!view.workspace?.entries.some(entry => entry.body === 'A local human conversation survives restart.')) throw new Error('Packaged workspace history did not survive quitting.');
  } else {
    view = await owner(root, A.CREATE, { title });
    view = await owner(view, A.POST, { body: 'A local human conversation survives restart.' });
    if (view.entry?.author.kind !== 'human') throw new Error('The packaged owner message lost its authorship.');
  }
  const roomId = view.workspace!.id;
  const grant = await options.create({ name: 'Packaged workspace agent', client: 'other',
    permissions: ['workspaces:read', 'workspaces:chat'], workspaceIds: [roomId], expiresInDays: 7 });
  view = await owner(view, A.INVITE, { memberId: grant.id, name: grant.name, kind: 'agent', role: 'contributor' });
  const peer = new Peer(options, grant.id);
  try {
    await peer.initialize();
    const list = await peer.request('tools/list') as { tools: { name: string }[] };
    if (!list.tools.some(tool => tool.name === 'interego_discover') || list.tools.some(tool => tool.name === 'interego_read_note')) throw new Error('Workspace grants changed unrelated packaged tools.');
    let agent = toolResult(await peer.request('tools/call', { name: 'interego_discover', arguments: {} }));
    if (agent.workspace || agent.workspaces?.some(room => room.entryCount !== 0)) throw new Error('An unaccepted workspace invitation disclosed history.');
    const accept = agent.affordances.find(value => value.action === A.ACCEPT);
    if (!accept) throw new Error('The packaged agent did not discover its invitation.');
    agent = toolResult(await peer.request('tools/call', { name: 'interego_act', arguments: { action: accept.action, target: accept.target, input: {} } }));
    const post = agent.affordances.find(value => value.action === A.POST);
    if (!post) throw new Error('The accepted packaged agent cannot find its chat action.');
    agent = toolResult(await peer.request('tools/call', { name: 'interego_act', arguments: {
      action: post.action, target: post.target, input: { body: 'A real packaged MCP agent joins this conversation.' },
    } }));
    if (agent.entry?.author.id !== grant.id || agent.entry.author.kind !== 'agent') throw new Error('The packaged agent message impersonated the owner.');
    view = await owner(view, A.READ, {}, roomId);
    const remove = view.affordances.find(value => value.action === A.REVOKE && value.target.endsWith(`:member:${encodeURIComponent(grant.id)}`));
    if (!remove) throw new Error('The packaged owner cannot remove the agent.');
    await owner(view, A.REVOKE, {}, remove.target);
    const denied = await peer.request('tools/call', { name: 'interego_act', arguments: { action: post.action, target: post.target, input: { body: 'Must not be written.' } } }) as { isError?: boolean };
    if (!denied.isError) throw new Error('Removed workspace membership still admitted a packaged write.');
    await options.revoke(grant.id);
  } finally { await peer.close(); }
  const discord = await options.invoke<{ configured: boolean; running: boolean }>('discordWorkspaceStatus');
  if (discord.configured || discord.running) throw new Error('Packaged Workspaces activated Discord without setup.');
  root = await options.invoke<WorkspaceRepresentation>('workspaceStatus');
  await owner(root, A.DISABLE);
  root = await options.invoke<WorkspaceRepresentation>('workspaceStatus');
  if (root.enabled || root.workspaces?.length) throw new Error('Pausing Workspaces did not hide conversations.');
}
