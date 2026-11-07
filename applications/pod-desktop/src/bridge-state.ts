/** Protected local authority for one stable bridge. Pending consent is never saved. */
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type { AgentPermission, AgentProtector } from './agent-types.js';
import type { BridgeStartInput } from './bridge-types.js';

export interface BridgeRegisteredClient { readonly id: string; readonly name: string; readonly redirects: readonly string[]; readonly expires: number }
export interface BridgeTokenFamily { readonly id: string; readonly clientId: string; readonly connectionId: string; readonly scopes: readonly AgentPermission[]; readonly expires: number; readonly refreshHash: string }
export interface BridgeAccess { readonly familyId: string; readonly expires: number }
export interface BridgeRetiredRefresh { readonly familyId: string; readonly expires: number }
export interface BridgeSavedState {
  readonly version: 1;
  readonly origin: string;
  readonly port: number;
  readonly podBinding: string;
  readonly configuration: BridgeStartInput;
  readonly clients: readonly BridgeRegisteredClient[];
  readonly families: readonly BridgeTokenFamily[];
  readonly access: readonly (readonly [string, BridgeAccess])[];
  readonly retired: readonly (readonly [string, BridgeRetiredRefresh])[];
  readonly connections: readonly string[];
}
export interface BridgeStateOptions {
  readonly dataDir: string;
  readonly protector: AgentProtector;
  readonly getPodBinding: () => Promise<string | null>;
}

const MAX_BYTES = 2 * 1024 * 1024;
const HASH = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ERROR = 'Saved web connections could not be opened. Forget the saved address to set it up again. Your notes are safe.';
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) throw new Error(ERROR);
  return value as Record<string, unknown>;
}
function text(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(ERROR);
  return value;
}
function time(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new Error(ERROR);
  return value;
}
function list(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) throw new Error(ERROR);
  return value;
}
function unique<T>(values: readonly T[]): readonly T[] { if (new Set(values).size !== values.length) throw new Error(ERROR); return values; }
function id(value: unknown, pattern: RegExp): string { const result = text(value, 128); if (!pattern.test(result)) throw new Error(ERROR); return result; }
function scopes(value: unknown): readonly AgentPermission[] {
  const values = list(value, 2);
  if (!values.length || values.some(scope => scope !== 'notes:read' && scope !== 'notes:create')) throw new Error(ERROR);
  return unique(values) as readonly AgentPermission[];
}
function secureUrl(value: unknown, originOnly: boolean): string {
  const valueText = text(value, 2048); let url: URL;
  try { url = new URL(valueText); } catch { throw new Error(ERROR); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || !url.hostname.includes('.') || url.hostname.startsWith('[')
    || /^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(url.hostname) || url.hostname.endsWith('.localhost')
    || (originOnly ? url.origin !== valueText : url.href !== valueText)) throw new Error(ERROR);
  return valueText;
}
function configuration(value: unknown): BridgeStartInput {
  const input = object(value, ['client', 'name', 'permissions', 'expiresInDays']);
  if (!['chatgpt-web', 'grok-bot', 'other-web'].includes(String(input['client'])) || typeof input['expiresInDays'] !== 'number' || ![7, 30, 90].includes(input['expiresInDays'])) throw new Error(ERROR);
  return { client: input['client'] as BridgeStartInput['client'], name: text(input['name'], 80), permissions: scopes(input['permissions']), expiresInDays: input['expiresInDays'] as 7 | 30 | 90 };
}
export function validateBridgeState(raw: unknown): BridgeSavedState {
  const value = object(raw, ['version', 'origin', 'port', 'podBinding', 'configuration', 'clients', 'families', 'access', 'retired', 'connections']);
  if (value['version'] !== 1 || !Number.isInteger(value['port']) || Number(value['port']) < 1024 || Number(value['port']) > 65535) throw new Error(ERROR);
  const policy = configuration(value['configuration']);
  const clients = list(value['clients'], 64).map(rawClient => {
    const client = object(rawClient, ['id', 'name', 'redirects', 'expires']);
    const redirects = unique(list(client['redirects'], 4).map(uri => secureUrl(uri, false)));
    if (!redirects.length) throw new Error(ERROR);
    return { id: id(client['id'], HASH), name: text(client['name'], 80), redirects, expires: time(client['expires']) };
  });
  unique(clients.map(client => client.id));
  const connections = unique(list(value['connections'], 16).map(connection => id(connection, UUID)));
  const families = list(value['families'], 16).map(rawFamily => {
    const family = object(rawFamily, ['id', 'clientId', 'connectionId', 'scopes', 'expires', 'refreshHash']);
    const result = { id: id(family['id'], UUID), clientId: id(family['clientId'], HASH), connectionId: id(family['connectionId'], UUID),
      scopes: scopes(family['scopes']), expires: time(family['expires']), refreshHash: id(family['refreshHash'], HASH) };
    if (!clients.some(client => client.id === result.clientId) || !connections.includes(result.connectionId) || result.scopes.some(scope => !policy.permissions.includes(scope))) throw new Error(ERROR);
    return result;
  });
  unique(families.map(family => family.id));
  const entries = (rawEntries: unknown, maximum: number) => {
    const result = list(rawEntries, maximum).map(rawEntry => {
      const pair = list(rawEntry, 2); if (pair.length !== 2) throw new Error(ERROR);
      const entry = object(pair[1], ['familyId', 'expires']);
      const familyId = id(entry['familyId'], UUID); const expires = time(entry['expires']);
      if (!families.some(family => family.id === familyId)) throw new Error(ERROR);
      return [id(pair[0], HASH), { familyId, expires }] as const;
    });
    unique(result.map(pair => pair[0])); return result;
  };
  return { version: 1, origin: secureUrl(value['origin'], true), port: Number(value['port']), podBinding: text(value['podBinding'], 256), configuration: policy,
    clients, families, access: entries(value['access'], 4096), retired: entries(value['retired'], 512), connections };
}

export class BridgeStateStore {
  private readonly directory: string;
  private readonly path: string;
  constructor(private readonly options: BridgeStateOptions) {
    if (!isAbsolute(options.dataDir)) throw new Error('Saved web connections need a private local folder.');
    this.directory = resolve(options.dataDir); this.path = join(this.directory, 'oauth-state.json');
  }
  binding(): Promise<string | null> { return this.options.getPodBinding(); }

  async load(): Promise<BridgeSavedState | null> {
    try {
      const directory = await lstat(this.directory);
      if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error(ERROR);
      const metadata = await lstat(this.path);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_BYTES) throw new Error(ERROR);
      const file = await open(this.path, 'r'); let bytes: Buffer;
      try {
        const actual = await file.stat();
        if (!actual.isFile() || actual.dev !== metadata.dev || actual.ino !== metadata.ino || actual.size > MAX_BYTES) throw new Error(ERROR);
        const buffer = Buffer.alloc(MAX_BYTES + 1); let total = 0;
        while (total < buffer.length) { const read = await file.read(buffer, total, buffer.length - total, null); if (!read.bytesRead) break; total += read.bytesRead; }
        if (total > MAX_BYTES) throw new Error(ERROR); bytes = buffer.subarray(0, total);
      } finally { await file.close(); }
      const wrapper = object(JSON.parse(bytes.toString('utf8')), ['version', 'ciphertext']);
      if (wrapper['version'] !== 1) throw new Error(ERROR);
      const raw = JSON.parse(this.options.protector.unprotect(text(wrapper['ciphertext'], MAX_BYTES))) as unknown;
      return raw === null ? null : validateBridgeState(raw);
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new Error(ERROR); }
  }

  async save(value: BridgeSavedState | null): Promise<void> {
    const validated = value === null ? null : validateBridgeState(value);
    const ciphertext = this.options.protector.protect(JSON.stringify(validated));
    const bytes = `${JSON.stringify({ version: 1, ciphertext })}\n`;
    if (Buffer.byteLength(bytes) > MAX_BYTES) throw new Error(ERROR);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const metadata = await lstat(this.directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(ERROR);
    const temporary = join(this.directory, `.oauth-${randomUUID()}.tmp`);
    try {
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(bytes, 'utf8'); await file.sync(); } finally { await file.close(); }
      await rename(temporary, this.path);
    } finally { await unlink(temporary).catch(() => {}); }
  }
}
