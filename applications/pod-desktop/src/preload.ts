import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopApi, FileActionResult, LocalNote, NoteInput, PodStatus } from './types.js';
import type { AgentConnection, AgentConnectionInput, AgentSetup } from './agent-types.js';
import type { BridgeClient, BridgeStartInput, BridgeStatus, StableBridgeInput, StableBridgeView } from './bridge-types.js';

async function invoke<T>(operation: string, argument?: unknown): Promise<T> {
  const reply = await ipcRenderer.invoke(`pod:${operation}`, argument) as
    { ok: true; value: T } | { ok: false; error: string };
  if (!reply.ok) throw new Error(reply.error);
  return reply.value;
}

const api: DesktopApi = Object.freeze({
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
});
contextBridge.exposeInMainWorld('interego', api);

declare global { interface Window { interego: DesktopApi } }
