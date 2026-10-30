/** Private provider settings. The renderer receives only the redacted view. */
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { isIP, createServer } from 'node:net';
import { isAbsolute, join, resolve } from 'node:path';
import type { AgentProtector } from './agent-types.js';
import type { BridgeStartInput, StableBridgeInput, StableBridgeView, StoredStableBridge } from './bridge-types.js';

const MAX_FILE_BYTES = 128 * 1024;
const SETTINGS_ERROR = 'Your saved bridge settings could not be opened. Your local notes are unchanged. Save the setup again or forget this address.';
const SAVE_ERROR = 'Your bridge settings could not be saved. Your existing settings and local notes are unchanged. Try again.';
const TOKEN_ERROR = 'Paste the tunnel token from Cloudflare, or its cloudflared service install command.';
const TOKEN = /^[A-Za-z0-9+/_=-]{32,8192}$/;

export interface StableBridgeStoreOptions {
  readonly dataDir: string;
  readonly protector: AgentProtector;
  readonly choosePort?: () => Promise<number>;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(SETTINGS_ERROR);
  return value as Record<string, unknown>;
}

/** A stable public origin is identity, not a general proxy destination. */
export function validateStableOrigin(value: unknown): string {
  const invalid = 'Enter a public HTTPS address such as https://pod.example.com, without a path, sign-in details or custom port.';
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020\u007f]/.test(value.trim())) throw new Error(invalid);
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error(invalid); }
  const host = url.hostname.toLowerCase();
  if (host === 'trycloudflare.com' || host.endsWith('.trycloudflare.com')) throw new Error('Choose a stable provider address. A temporary trycloudflare.com link cannot be saved as a permanent address.');
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.port
    || isIP(host) || host.startsWith('[') || host.length > 253 || !host.includes('.')
    || /(?:^|\.)(?:localhost|local|internal|lan|home|invalid|onion)$/.test(host) || host.endsWith('.home.arpa')
    || !host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) throw new Error(invalid);
  return url.origin;
}

/** Accept the documented copied command as data. It is never executed. */
export function parseTunnelToken(value: unknown): string {
  if (typeof value !== 'string' || value.length > 16_384) throw new Error(TOKEN_ERROR);
  const text = value.trim();
  if (/[\u0000-\u001f\u007f]/.test(text)) throw new Error(TOKEN_ERROR);
  if (TOKEN.test(text)) return text;
  const command = /^cloudflared(?:\.exe)?\s+(?:service\s+install|tunnel\s+run\s+--token)\s+(["']?)([A-Za-z0-9+/_=-]{32,8192})\1$/i.exec(text);
  if (!command?.[2]) throw new Error(TOKEN_ERROR);
  return command[2];
}

function policy(value: unknown): BridgeStartInput {
  const raw = object(value);
  if (Object.keys(raw).sort().join(',') !== 'client,expiresInDays,name,permissions'
    || !['chatgpt-web', 'grok-bot', 'other-web'].includes(String(raw['client']))
    || typeof raw['name'] !== 'string' || !raw['name'].trim() || raw['name'].trim().length > 80 || /[\u0000-\u001f\u007f]/.test(raw['name'])
    || ![7, 30, 90].includes(Number(raw['expiresInDays'])) || typeof raw['expiresInDays'] !== 'number'
    || !Array.isArray(raw['permissions']) || raw['permissions'].length < 1 || raw['permissions'].length > 2
    || new Set(raw['permissions']).size !== raw['permissions'].length
    || raw['permissions'].some(scope => scope !== 'notes:read' && scope !== 'notes:create')) throw new Error('Choose the app, permissions and expiry for this bridge.');
  return { client: raw['client'] as BridgeStartInput['client'], name: raw['name'].trim(),
    expiresInDays: raw['expiresInDays'] as BridgeStartInput['expiresInDays'], permissions: [...raw['permissions']] };
}

function stored(value: unknown): StoredStableBridge {
  const raw = object(value);
  const keys = Object.keys(raw).sort().join(',');
  if (!['origin,policy,port,provider', 'origin,policy,port,provider,token'].includes(keys)
    || (raw['provider'] !== 'cloudflare' && raw['provider'] !== 'external')
    || !Number.isInteger(raw['port']) || Number(raw['port']) < 1024 || Number(raw['port']) > 65535) throw new Error(SETTINGS_ERROR);
  const provider = raw['provider'];
  if ((provider === 'external' && raw['token'] !== undefined) || (provider === 'cloudflare' && (typeof raw['token'] !== 'string' || !TOKEN.test(raw['token'])))) throw new Error(SETTINGS_ERROR);
  return { provider, origin: validateStableOrigin(raw['origin']), port: Number(raw['port']), policy: policy(raw['policy']),
    ...(provider === 'cloudflare' ? { token: raw['token'] as string } : {}) };
}

function view(record: StoredStableBridge): StableBridgeView {
  return { provider: record.provider, origin: record.origin, port: record.port, hasCredential: !!record.token,
    policy: { ...record.policy, permissions: [...record.policy.permissions] } };
}

async function chooseLocalPort(): Promise<number> {
  const server = createServer();
  try {
    await new Promise<void>((done, fail) => {
      server.once('error', fail);
      server.listen(0, '127.0.0.1', () => { server.off('error', fail); done(); });
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error(SAVE_ERROR);
    return address.port;
  } finally {
    if (server.listening) await new Promise<void>((done, fail) => server.close(error => error ? fail(error) : done()));
  }
}

export class StableBridgeStore {
  private readonly directory: string;
  private readonly path: string;
  private mutation: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: StableBridgeStoreOptions) {
    if (!isAbsolute(options.dataDir)) throw new Error('Saved bridge settings need a dedicated local folder.');
    this.directory = resolve(options.dataDir);
    this.path = join(this.directory, 'stable-bridge.json');
  }

  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const task = this.mutation.then(action);
    this.mutation = task.catch(() => undefined);
    return task;
  }

  private async directoryReady(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const metadata = await lstat(this.directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(SETTINGS_ERROR);
  }

  private async load(): Promise<StoredStableBridge | null> {
    try {
      const directory = await lstat(this.directory);
      if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error(SETTINGS_ERROR);
      const before = await lstat(this.path);
      if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_FILE_BYTES) throw new Error(SETTINGS_ERROR);
      const file = await open(this.path, 'r');
      let text: string;
      try {
        const current = await file.stat();
        if (!current.isFile() || current.dev !== before.dev || current.ino !== before.ino || current.size > MAX_FILE_BYTES) throw new Error(SETTINGS_ERROR);
        const bytes = Buffer.alloc(MAX_FILE_BYTES + 1); let total = 0;
        while (total < bytes.length) {
          const next = await file.read(bytes, total, bytes.length - total, null);
          if (!next.bytesRead) break;
          total += next.bytesRead;
        }
        if (total > MAX_FILE_BYTES) throw new Error(SETTINGS_ERROR);
        text = bytes.subarray(0, total).toString('utf8');
      } finally { await file.close(); }
      const wrapper = object(JSON.parse(text));
      if (Object.keys(wrapper).sort().join(',') !== 'ciphertext,version' || wrapper['version'] !== 1 || typeof wrapper['ciphertext'] !== 'string') throw new Error(SETTINGS_ERROR);
      const raw = JSON.parse(this.options.protector.unprotect(wrapper['ciphertext'])) as unknown;
      return raw === null ? null : stored(raw);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new Error(SETTINGS_ERROR);
    }
  }

  get(): Promise<StoredStableBridge | null> { return this.serialize(() => this.load()); }
  view(): Promise<StableBridgeView | null> { return this.serialize(async () => { const record = await this.load(); return record ? view(record) : null; }); }

  private async persist(record: StoredStableBridge | null): Promise<void> {
    await this.directoryReady();
    const ciphertext = this.options.protector.protect(JSON.stringify(record));
    const bytes = Buffer.from(`${JSON.stringify({ version: 1, ciphertext })}\n`);
    if (bytes.length > MAX_FILE_BYTES) throw new Error(SAVE_ERROR);
    const temporary = join(this.directory, `.stable-${randomUUID()}.tmp`);
    try {
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
      await rename(temporary, this.path);
    } finally { await unlink(temporary).catch(() => {}); }
  }

  save(input: StableBridgeInput): Promise<StableBridgeView> {
    return this.serialize(async () => {
      const raw = object(input);
      if (Object.keys(raw).some(key => !['provider', 'origin', 'token', 'policy'].includes(key))
        || (raw['provider'] !== 'cloudflare' && raw['provider'] !== 'external')) throw new Error('Choose a supported stable connection provider.');
      const provider = raw['provider']; const origin = validateStableOrigin(raw['origin']); const selected = policy(raw['policy']);
      const previous = await this.load(); const same = previous?.provider === provider && previous.origin === origin;
      let token: string | undefined;
      if (provider === 'cloudflare') {
        token = (raw['token'] === undefined || (typeof raw['token'] === 'string' && !raw['token'].trim())) && same
          ? previous.token : parseTunnelToken(raw['token']);
        if (!token) throw new Error(TOKEN_ERROR);
      } else if (raw['token'] !== undefined && raw['token'] !== '') throw new Error('This provider manages its own credentials. Leave the tunnel token empty.');
      try {
        const port = same ? previous.port : await (this.options.choosePort ?? chooseLocalPort)();
        if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(SAVE_ERROR);
        const record: StoredStableBridge = { provider, origin, port, policy: selected, ...(token ? { token } : {}) };
        await this.persist(record);
        return view(record);
      } catch { throw new Error(SAVE_ERROR); }
    });
  }

  clear(): Promise<void> { return this.serialize(async () => { try { await this.persist(null); } catch { throw new Error(SAVE_ERROR); } }); }
}
