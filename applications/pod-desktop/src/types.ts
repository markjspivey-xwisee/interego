export type PodState = 'unconfigured' | 'stopped' | 'starting' | 'running' | 'stopping' | 'error';

export interface PodStatus {
  readonly state: PodState;
  readonly configured: boolean;
  readonly running: boolean;
  readonly localOnly: true;
  readonly federationEnabled: false;
  readonly noteCount: number;
  readonly lastError?: string;
  readonly restorePending?: boolean;
}

export interface LocalNote {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface NoteInput { readonly title: string; readonly body: string; }
export interface FileActionResult { readonly cancelled: boolean; readonly status: PodStatus; }

export interface DesktopApi {
  status(): Promise<PodStatus>;
  setup(): Promise<PodStatus>;
  start(): Promise<PodStatus>;
  stop(): Promise<PodStatus>;
  notes(): Promise<readonly LocalNote[]>;
  saveNote(input: NoteInput): Promise<LocalNote>;
  backup(passphrase: string): Promise<FileActionResult>;
  restore(passphrase: string): Promise<FileActionResult>;
  openDataFolder(): Promise<void>;
  openHosted(): Promise<void>;
}
