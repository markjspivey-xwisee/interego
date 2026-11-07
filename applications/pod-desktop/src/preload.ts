import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopApi, FileActionResult, LocalNote, NoteInput, PodStatus } from './types.js';
import type { AgentConnection, AgentConnectionInput, AgentSetup } from './agent-types.js';
import type { BridgeClient, BridgeStartInput, BridgeStatus, StableBridgeInput, StableBridgeView } from './bridge-types.js';
import type { FederationStatus, FederationResource } from '@interego/pod-federation';
import type { LocalIdentityStatus } from './local-identity-types.js';
import type { WorkspaceActRequest, WorkspaceRepresentation } from './workspace-types.js';
import type { DiscordWorkspaceConfiguration, DiscordWorkspaceStatus } from './discord-workspaces.js';

async function invoke<T>(operation: string, argument?: unknown): Promise<T> {
  const reply = await ipcRenderer.invoke(`pod:${operation}`, argument) as
    { ok: true; value: T } | { ok: false; error: string };
  if (!reply.ok) throw new Error(reply.error);
  return reply.value;
}

const api: DesktopApi = Object.freeze({
  workspaceStatus: () => invoke<WorkspaceRepresentation>('workspaceStatus'),
  workspaceAct: (request: WorkspaceActRequest) => invoke<WorkspaceRepresentation>('workspaceAct', request),
  discordWorkspaceStatus: () => invoke<DiscordWorkspaceStatus>('discordWorkspaceStatus'),
  configureDiscordWorkspace: (input: DiscordWorkspaceConfiguration) => invoke<DiscordWorkspaceStatus>('configureDiscordWorkspace', input),
  startDiscordWorkspace: () => invoke<DiscordWorkspaceStatus>('startDiscordWorkspace'),
  stopDiscordWorkspace: () => invoke<DiscordWorkspaceStatus>('stopDiscordWorkspace'),
  disconnectDiscordWorkspace: () => invoke<DiscordWorkspaceStatus>('disconnectDiscordWorkspace'),
  openDiscordWorkspaceSetup: () => invoke<void>('openDiscordWorkspaceSetup'),
  localIdentityStatus: () => invoke<LocalIdentityStatus>('localIdentityStatus'),
  setupLocalIdentity: () => invoke<LocalIdentityStatus>('setupLocalIdentity'),
  approveLocalIdentity: (id: string, verificationCode: string) => invoke<LocalIdentityStatus>('approveLocalIdentity', { id, verificationCode }),
  denyLocalIdentity: (id: string) => invoke<LocalIdentityStatus>('denyLocalIdentity', id),
  forgetLocalIdentity: () => invoke<LocalIdentityStatus>('forgetLocalIdentity'),
  identityExtensionIds: () => invoke<readonly string[]>('identityExtensionIds'),
  setIdentityExtensionIds: (ids: readonly string[]) => invoke<readonly string[]>('setIdentityExtensionIds', ids),
  backupLocalIdentity: (passphrase: string) => invoke<{ cancelled: boolean; status: LocalIdentityStatus }>('backupLocalIdentity', passphrase),
  restoreLocalIdentity: (passphrase: string) => invoke<{ cancelled: boolean; status: LocalIdentityStatus }>('restoreLocalIdentity', passphrase),
  status: () => invoke<PodStatus>('status'),
  setup: () => invoke<PodStatus>('setup'),
  start: () => invoke<PodStatus>('start'),
  stop: () => invoke<PodStatus>('stop'),
  notes: () => invoke<readonly LocalNote[]>('notes'),
  saveNote: (note: NoteInput) => invoke<LocalNote>('saveNote', note),
  backup: (passphrase: string) => invoke<FileActionResult>('backup', passphrase),
  restore: (passphrase: string) => invoke<FileActionResult>('restore', passphrase),
  openDataFolder: () => invoke<void>('openDataFolder'),
  openHosted: () => invoke<void>('openHosted'),
  connections: () => invoke<readonly AgentConnection[]>('connections'),
  createConnection: (input: AgentConnectionInput) => invoke<AgentConnection>('createConnection', input),
  revokeConnection: (id: string) => invoke<void>('revokeConnection', id),
  connectionSetup: (id: string) => invoke<AgentSetup>('connectionSetup', id),
  copyConnectionSetup: (id: string, format: 'configuration' | 'command') => invoke<void>('copyConnectionSetup', { id, format }),
  bridgeStatus: () => invoke<BridgeStatus>('bridgeStatus'),
  startBridge: (input: BridgeStartInput) => invoke<BridgeStatus>('startBridge', input),
  stopBridge: () => invoke<BridgeStatus>('stopBridge'),
  approveBridge: (id: string) => invoke<BridgeStatus>('approveBridge', id),
  denyBridge: (id: string) => invoke<BridgeStatus>('denyBridge', id),
  copyBridgeUrl: () => invoke<void>('copyBridgeUrl'),
  openBridgeClient: (client: BridgeClient) => invoke<void>('openBridgeClient', client),
  stableBridgeSettings: () => invoke<StableBridgeView | null>('stableBridgeSettings'),
  saveStableBridge: (input: StableBridgeInput) => invoke<StableBridgeView>('saveStableBridge', input),
  resumeBridge: () => invoke<BridgeStatus>('resumeBridge'),
  forgetStableBridge: () => invoke<BridgeStatus>('forgetStableBridge'),
  copyStableBridgeTarget: () => invoke<void>('copyStableBridgeTarget'),
  openStableBridgeSetup: () => invoke<void>('openStableBridgeSetup'),
  browserExtensionIds: () => invoke<readonly string[]>('browserExtensionIds'),
  setBrowserExtensionIds: (ids: readonly string[]) => invoke<readonly string[]>('setBrowserExtensionIds', ids),
  federationStatus: () => invoke<FederationStatus>('federationStatus'),
  enableFederation: (name: string) => invoke<FederationStatus>('enableFederation', name),
  disableFederation: () => invoke<FederationStatus>('disableFederation'),
  createFederationInvite: () => invoke<{ id: string; code: string; expiresAt: string }>('createFederationInvite'),
  copyFederationInvite: (code: string) => invoke<void>('copyFederationInvite', code),
  acceptFederationInvite: (code: string) => invoke<FederationStatus>('acceptFederationInvite', code),
  approveFederation: (id: string, verificationCode: string) => invoke<FederationStatus>('approveFederation', { id, verificationCode }),
  denyFederation: (id: string) => invoke<FederationStatus>('denyFederation', id),
  refreshFederation: () => invoke<FederationStatus>('refreshFederation'),
  shareFederation: (input: { peerId: string; noteIds: readonly string[] }) => invoke<FederationStatus>('shareFederation', input),
  readFederation: (id: string) => invoke<FederationResource & { note?: { title: string; body: string } }>('readFederation', id),
  revokeFederation: (id: string) => invoke<FederationStatus>('revokeFederation', id),
  forgetFederation: () => invoke<FederationStatus>('forgetFederation'),
  removeFederationSnapshot: (id: string) => invoke<FederationStatus>('removeFederationSnapshot', id),
  clearFederationHistory: () => invoke<FederationStatus>('clearFederationHistory'),
});
contextBridge.exposeInMainWorld('interego', api);

declare global { interface Window { interego: DesktopApi } }
