import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopApi, FileActionResult, LocalNote, NoteInput, PodStatus } from './types.js';

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
});
contextBridge.exposeInMainWorld('interego', api);

declare global { interface Window { interego: DesktopApi } }
