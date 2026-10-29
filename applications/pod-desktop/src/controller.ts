import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, pbkdf2, randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open, readFile, rename, rmdir, unlink } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import {
  ContextDescriptor, escapeTurtleLiteral, generateKeyPair, turtleIriRef,
  parseTrig, type EncryptionKeyPair, type IRI,
} from '@interego/core';
import { resolveDeploymentConfig, type LocalDeploymentConfig } from '@interego/deployment-config';
import type { LocalNode, LocalNodeOptions } from '@interego/local-node';
import { discover, fetchGraphContent, parseDistributionFromDescriptorTurtle, publish, type FetchFn } from '@interego/solid';
import type { LocalNote, NoteInput, PodState, PodStatus } from './types.js';

export interface PodKeyVault {
  load(): Promise<EncryptionKeyPair | null>;
  save(key: EncryptionKeyPair): Promise<void>;
}

export interface PodControllerOptions {
  readonly dataDir: string;
  readonly vault: PodKeyVault;
}

interface PodProfile {
  readonly version: 1;
  readonly baseUrl: string;
  readonly keyFingerprint: string;
}

interface NotesSnapshot {
  readonly format: 'interego-notes-snapshot';
  readonly version: 1;
  readonly exportedAt: string;
  readonly contentKey: EncryptionKeyPair;
  readonly notes: readonly LocalNote[];
}

interface RestoreCommit {
  readonly version: 1;
  readonly backupHash: string;
  readonly baseUrl: string;
  readonly keyFingerprint: string;
  readonly stagingName: string;
}

const deriveKey = promisify(pbkdf2);
const GRAPH_PREFIX = 'urn:graph:pod-note:';
const RDF_VALUE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#value' as IRI;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ITERATIONS = 600_000;
const MAX_BACKUP_BYTES = 32 * 1024 * 1024;
const BACKUP_AAD = Buffer.from('interego-notes-backup:v1:PBKDF2-SHA256:600000:AES-256-GCM');

async function launchLocal(config: LocalDeploymentConfig, options: LocalNodeOptions): Promise<LocalNode> {
  const { startLocalNode } = await import('@interego/local-node');
  return startLocalNode(config, options);
}

class PodError extends Error {}

function fingerprint(key: EncryptionKeyPair): string {
  return createHash('sha256').update(key.publicKey).digest('hex');
}

function keyPair(value: unknown): EncryptionKeyPair {
  if (!value || typeof value !== 'object') throw new PodError('Your pod encryption key is missing or damaged. Restore a notes backup.');
  const key = value as Partial<EncryptionKeyPair>;
  const valid = (text: unknown): text is string => typeof text === 'string'
    && Buffer.from(text, 'base64').length === 32 && Buffer.from(text, 'base64').toString('base64') === text;
  if (key.algorithm !== 'X25519-XSalsa20-Poly1305' || !valid(key.publicKey) || !valid(key.secretKey)) {
    throw new PodError('Your pod encryption key is missing or damaged. Restore a notes backup.');
  }
  const result: EncryptionKeyPair = { algorithm: 'X25519-XSalsa20-Poly1305', publicKey: key.publicKey, secretKey: key.secretKey };
  const rawSecret = Buffer.from(result.secretKey, 'base64');
  const encoded = Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), rawSecret]);
  try {
    const privateKey = createPrivateKey({ key: encoded, format: 'der', type: 'pkcs8' });
    const derived = createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).subarray(-32);
    if (!derived.equals(Buffer.from(result.publicKey, 'base64'))) throw new Error('mismatch');
  } catch { throw new PodError('Your pod encryption key does not match. Your stored notes were kept unchanged.'); }
  finally { rawSecret.fill(0); encoded.fill(0); }
  return result;
}

function noteInput(value: NoteInput): NoteInput {
  if (!value || typeof value.title !== 'string' || typeof value.body !== 'string') throw new PodError('Enter a title and note.');
  if (!value.title.trim() || value.title.length > 160) throw new PodError('Give your note a title of up to 160 characters.');
  if (!value.body.trim() || value.body.length > 50_000) throw new PodError('Enter a note of up to 50,000 characters.');
  return { title: value.title.trim(), body: value.body };
}

function savedNote(value: unknown): LocalNote {
  if (!value || typeof value !== 'object') throw new PodError('A saved note could not be read.');
  const record = value as Partial<LocalNote>;
  const input = noteInput(record as NoteInput);
  if (typeof record.id !== 'string' || !UUID.test(record.id)
    || typeof record.createdAt !== 'string' || !Number.isFinite(Date.parse(record.createdAt))
    || typeof record.updatedAt !== 'string' || !Number.isFinite(Date.parse(record.updatedAt))) {
    throw new PodError('A saved note could not be read.');
  }
  return { id: record.id, ...input, createdAt: record.createdAt, updatedAt: record.updatedAt };
}

function passphrase(value: string): void {
  if (typeof value !== 'string' || value.length < 12 || value.length > 1024) {
    throw new PodError('Use a backup passphrase between 12 and 1,024 characters.');
  }
}

function base64(value: unknown, length?: number): Buffer {
  if (typeof value !== 'string') throw new PodError('This is not a supported notes backup.');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value || (length !== undefined && bytes.length !== length)) {
    throw new PodError('This notes backup is damaged.');
  }
  return bytes;
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

/**
 * Local consumer controller. Its host MUST hold the Electron single-instance lock
 * before constructing it. That excludes another controller while stale locks are recovered;
 * the generic local runtime continues to fail closed on a lock it did not create.
 */
export class PodController {
  private readonly dataDir: string;
  private readonly storeDir: string;
  private readonly profilePath: string;
  private readonly restorePath: string;
  private readonly vault: PodKeyVault;
  private node: LocalNode | undefined;
  private state: PodState = 'unconfigured';
  private noteCount = 0;
  private lastError: string | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: PodControllerOptions) {
    if (!isAbsolute(options.dataDir)) throw new PodError('Choose a dedicated local folder for your pod.');
    this.dataDir = resolve(options.dataDir);
    this.storeDir = join(this.dataDir, 'store');
    this.profilePath = join(this.dataDir, 'pod-profile.json');
    this.restorePath = join(this.dataDir, 'restore-pending.json');
    this.vault = options.vault;
  }

  private action<T>(fallback: string, perform: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(async () => {
      try {
        this.lastError = undefined;
        const result = await perform();
        if (this.node && this.state === 'error') this.state = 'running';
        return result;
      }
      catch (error) {
        this.state = 'error';
        this.lastError = error instanceof PodError ? error.message : fallback;
        throw new PodError(this.lastError);
      }
    });
    this.queue = pending.catch(() => undefined);
    return pending;
  }

  private async profile(): Promise<PodProfile | null> {
    if (!await exists(this.profilePath)) return null;
    try {
      const stat = await lstat(this.profilePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error('profile');
      const value = JSON.parse(await readFile(this.profilePath, 'utf8')) as Partial<PodProfile>;
      if (value.version !== 1 || typeof value.baseUrl !== 'string' || !/^[a-f0-9]{64}$/.test(value.keyFingerprint ?? '')) throw new Error('profile');
      resolveDeploymentConfig({ profile: 'local', dataDir: this.storeDir, baseUrl: value.baseUrl });
      return value as PodProfile;
    } catch { throw new PodError('Your pod settings could not be read. Your saved data was kept unchanged.'); }
  }

  private async saveJson(path: string, value: unknown): Promise<void> {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    const temporary = join(this.dataDir, `.profile-${randomUUID()}.tmp`);
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(value), 'utf8'); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, path);
  }

  private async saveProfile(profile: PodProfile): Promise<void> {
    await this.saveJson(this.profilePath, profile);
  }

  private async restoreCommit(): Promise<RestoreCommit | null> {
    if (!await exists(this.restorePath)) return null;
    try {
      const stat = await lstat(this.restorePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error('marker');
      const value = JSON.parse(await readFile(this.restorePath, 'utf8')) as Partial<RestoreCommit>;
      if (value.version !== 1 || typeof value.baseUrl !== 'string'
        || !/^[a-f0-9]{64}$/.test(value.backupHash ?? '') || !/^[a-f0-9]{64}$/.test(value.keyFingerprint ?? '')
        || !/^\.restore-[A-Za-z0-9]{6,64}$/.test(value.stagingName ?? '')) throw new Error('marker');
      resolveDeploymentConfig({ profile: 'local', dataDir: this.storeDir, baseUrl: value.baseUrl });
      return value as RestoreCommit;
    } catch { throw new PodError('The interrupted restore could not be verified. Your stored data was kept unchanged.'); }
  }

  private async chooseEndpoint(): Promise<string> {
    const listener = createServer();
    await new Promise<void>((done, fail) => {
      listener.once('error', fail);
      listener.listen(0, '127.0.0.1', () => { listener.off('error', fail); done(); });
    });
    const address = listener.address();
    await new Promise<void>((done, fail) => listener.close(error => error ? fail(error) : done()));
    if (!address || typeof address === 'string') throw new Error('No local endpoint was assigned.');
    return `http://127.0.0.1:${address.port}/`;
  }

  private async recoverDeadRuntimeLock(): Promise<void> {
    const path = join(this.storeDir, 'runtime.lock');
    if (!await exists(path)) return;
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new PodError('Your pod has an unfamiliar lock file. Your data was kept unchanged.');
    const original = await readFile(path, 'utf8');
    let value: { version?: unknown; id?: unknown; pid?: unknown };
    try { value = JSON.parse(original) as typeof value; }
    catch { throw new PodError('Your pod lock could not be verified. Your data was kept unchanged.'); }
    if (value.version !== 1 || typeof value.id !== 'string' || !UUID.test(value.id)
      || !Number.isSafeInteger(value.pid) || Number(value.pid) <= 0) throw new PodError('Your pod lock could not be verified. Your data was kept unchanged.');
    try {
      process.kill(Number(value.pid), 0);
      throw new PodError('Your pod is already running. Close the other pod window before starting it here.');
    } catch (error) {
      if (error instanceof PodError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw new PodError('Your pod may still be running. Its lock was kept for safety.');
    }
    const currentStat = await lstat(path);
    if (!currentStat.isFile() || currentStat.isSymbolicLink() || await readFile(path, 'utf8') !== original) {
      throw new PodError('Your pod lock changed. Try starting the pod again.');
    }
    await unlink(path);
  }

  async getStatus(): Promise<PodStatus> {
    let configured = false;
    try { configured = Boolean(await this.profile()); }
    catch (error) { this.state = 'error'; this.lastError = (error as Error).message; }
    const state = this.state === 'unconfigured' && configured ? 'stopped' : this.state;
    const restorePending = await exists(this.restorePath);
    return { state, configured, running: Boolean(this.node), localOnly: true, federationEnabled: false,
      noteCount: this.noteCount, ...(this.lastError ? { lastError: this.lastError } : {}), ...(restorePending ? { restorePending: true } : {}) };
  }

  setup(): Promise<PodStatus> {
    return this.action('Your pod could not be created. Your saved data was kept unchanged.', async () => {
      if (await this.profile()) throw new PodError('Your pod is already set up. Start it to see your notes.');
      if (await exists(this.restorePath)) throw new PodError('Choose the same notes backup to finish restoring your pod.');
      if (await exists(this.storeDir)) throw new PodError('This folder already contains pod data. Your existing data was kept unchanged.');
      this.state = 'starting';
      const previous = await this.vault.load();
      const key = previous ? keyPair(previous) : generateKeyPair();
      if (!previous) await this.vault.save(key);
      await this.saveProfile({ version: 1, baseUrl: await this.chooseEndpoint(), keyFingerprint: fingerprint(key) });
      await this.startInternal();
      return this.getStatus();
    });
  }

  private async startInternal(): Promise<void> {
    if (await exists(this.restorePath)) throw new PodError('Choose the same notes backup to finish restoring your pod.');
    if (this.node) { this.state = 'running'; return; }
    const profile = await this.profile();
    if (!profile) throw new PodError('Create your local pod or restore a notes backup first.');
    const key = keyPair(await this.vault.load());
    if (fingerprint(key) !== profile.keyFingerprint) throw new PodError('This encryption key belongs to another pod. Your saved notes were kept unchanged.');
    this.state = 'starting';
    await this.recoverDeadRuntimeLock();
    this.node = await launchLocal(resolveDeploymentConfig({ profile: 'local', dataDir: this.storeDir, baseUrl: profile.baseUrl }), { startupTimeoutMs: 120_000 });
    this.noteCount = (await this.readNotes(this.node, key)).length;
    this.state = 'running';
  }

  start(): Promise<PodStatus> {
    return this.action('Your pod could not start. Its data was kept unchanged. Another app may be using its local connection.', async () => {
      await this.startInternal(); return this.getStatus();
    });
  }

  stop(): Promise<PodStatus> {
    return this.action('Your pod could not finish stopping. Close the app before trying again.', async () => {
      this.state = 'stopping';
      await this.node?.stop();
      this.node = undefined;
      this.state = await this.profile() ? 'stopped' : 'unconfigured';
      return this.getStatus();
    });
  }

  private runningNode(): LocalNode {
    if (!this.node) throw new PodError('Start your pod to read or save notes.');
    return this.node;
  }

  private async readNotes(node: LocalNode, key: EncryptionKeyPair): Promise<LocalNote[]> {
    const entries = await discover(node.podUrl, undefined, { fetch: node.fetch as FetchFn });
    const result: LocalNote[] = [];
    const seen = new Set<string>();
    for (const entry of entries) {
      const graph = entry.describes.find(iri => iri.startsWith(GRAPH_PREFIX));
      if (!graph) continue;
      const id = graph.slice(GRAPH_PREFIX.length);
      if (!UUID.test(id) || seen.has(id)) throw new PodError('The pod contains an unfamiliar note record. Your data was kept unchanged.');
      const response = await node.fetch(entry.descriptorUrl, { headers: { accept: 'text/turtle' } });
      if (!response.ok) throw new PodError('A saved note could not be opened.');
      const distribution = parseDistributionFromDescriptorTurtle(await response.text());
      if (!distribution?.encrypted || distribution.visibility !== 'private') throw new PodError('A note does not have the expected private encryption.');
      const payload = await fetchGraphContent(distribution.accessURL, { fetch: node.fetch as FetchFn, recipientKeyPair: key });
      if (!payload.encrypted || payload.content === null) throw new PodError('A saved note could not be decrypted with this pod key.');
      const subject = parseTrig(payload.content).subjects.find(row => row.subject === `urn:uuid:${id}`);
      const terms = subject?.properties.get(RDF_VALUE);
      if (terms?.length !== 1 || terms[0]?.kind !== 'literal') throw new PodError('A saved note has an unfamiliar format.');
      const note = savedNote(JSON.parse(terms[0].value));
      if (note.id !== id) throw new PodError('A saved note does not match its record.');
      seen.add(id); result.push(note);
    }
    return result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  }

  listNotes(): Promise<readonly LocalNote[]> {
    return this.action('Your notes could not be read. Your saved data was kept unchanged.', async () => {
      const notes = await this.readNotes(this.runningNode(), keyPair(await this.vault.load()));
      this.noteCount = notes.length; return notes;
    });
  }

  private async publishNote(node: LocalNode, key: EncryptionKeyPair, note: LocalNote): Promise<void> {
    const graph = `${GRAPH_PREFIX}${note.id}` as IRI;
    const descriptor = ContextDescriptor.create(`urn:uuid:${note.id}` as IRI).describes(graph)
      .validFrom(note.createdAt).selfAsserted(`urn:sha256:${fingerprint(key)}` as IRI).build();
    const subject = turtleIriRef(`urn:uuid:${note.id}`);
    const predicate = turtleIriRef(RDF_VALUE);
    if (!subject || !predicate) throw new PodError('This note could not be prepared for storage. Your saved notes have not been changed.');
    const content = `${subject} ${predicate} "${escapeTurtleLiteral(JSON.stringify(note))}" .`;
    await publish(descriptor, content, node.podUrl, { fetch: node.fetch as FetchFn,
      visibility: 'private', encrypt: { recipients: [key.publicKey], senderKeyPair: key } });
  }

  saveNote(input: NoteInput): Promise<LocalNote> {
    return this.action('Your note could not be saved. Keep your text and try again.', async () => {
      const validated = noteInput(input);
      const now = new Date().toISOString();
      const note: LocalNote = { id: randomUUID(), ...validated, createdAt: now, updatedAt: now };
      await this.publishNote(this.runningNode(), keyPair(await this.vault.load()), note);
      this.noteCount++; return note;
    });
  }

  exportBackup(phrase: string): Promise<Uint8Array> {
    return this.action('Your notes backup could not be created. Your saved notes were kept unchanged.', async () => {
      passphrase(phrase);
      await this.startInternal();
      const key = keyPair(await this.vault.load());
      const notes = await this.readNotes(this.runningNode(), key);
      const snapshot: NotesSnapshot = { format: 'interego-notes-snapshot', version: 1, exportedAt: new Date().toISOString(), contentKey: key, notes };
      const plain = Buffer.from(JSON.stringify(snapshot));
      if (plain.length > MAX_BACKUP_BYTES / 2) throw new PodError('These notes are too large for this backup format.');
      const salt = randomBytes(16); const iv = randomBytes(12);
      const derived = await deriveKey(phrase, salt, ITERATIONS, 32, 'sha256');
      try {
        const cipher = createCipheriv('aes-256-gcm', derived, iv); cipher.setAAD(BACKUP_AAD);
        const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
        return Buffer.from(JSON.stringify({ format: 'interego-notes-backup', version: 1, kdf: 'PBKDF2-SHA256', iterations: ITERATIONS,
          cipher: 'AES-256-GCM', salt: salt.toString('base64'), iv: iv.toString('base64'),
          tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') }));
      } finally { derived.fill(0); plain.fill(0); }
    });
  }

  private async openBackup(bytes: Uint8Array, phrase: string): Promise<NotesSnapshot> {
    passphrase(phrase);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_BACKUP_BYTES) throw new PodError('This notes backup is too large or has an unfamiliar format.');
    let outer: Record<string, unknown>;
    try { outer = JSON.parse(Buffer.from(bytes).toString('utf8')) as typeof outer; }
    catch { throw new PodError('This is not a supported notes backup.'); }
    if (!outer || outer.format !== 'interego-notes-backup' || outer.version !== 1 || outer.kdf !== 'PBKDF2-SHA256'
      || outer.iterations !== ITERATIONS || outer.cipher !== 'AES-256-GCM') throw new PodError('This is not a supported notes backup.');
    const salt = base64(outer.salt, 16); const iv = base64(outer.iv, 12); const tag = base64(outer.tag, 16); const ciphertext = base64(outer.ciphertext);
    const derived = await deriveKey(phrase, salt, ITERATIONS, 32, 'sha256');
    let plain: Buffer;
    try {
      const decipher = createDecipheriv('aes-256-gcm', derived, iv); decipher.setAAD(BACKUP_AAD); decipher.setAuthTag(tag);
      plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch { throw new PodError('The backup passphrase is incorrect or the backup has been damaged. Nothing was restored.'); }
    finally { derived.fill(0); }
    try {
      const snapshot = JSON.parse(plain.toString('utf8')) as Partial<NotesSnapshot>;
      if (snapshot.format !== 'interego-notes-snapshot' || snapshot.version !== 1 || !Array.isArray(snapshot.notes)
        || snapshot.notes.length > 10_000 || typeof snapshot.exportedAt !== 'string') throw new Error('snapshot');
      const notes = snapshot.notes.map(savedNote);
      if (new Set(notes.map(note => note.id)).size !== notes.length) throw new Error('duplicate');
      return { format: 'interego-notes-snapshot', version: 1, exportedAt: snapshot.exportedAt, contentKey: keyPair(snapshot.contentKey), notes };
    } catch { throw new PodError('This notes backup has an unfamiliar or damaged contents format. Nothing was restored.'); }
    finally { plain.fill(0); }
  }

  restoreBackup(bytes: Uint8Array, phrase: string): Promise<PodStatus> {
    return this.action('The notes restore did not finish. Your backup file has not changed.', async () => {
      const pending = await this.restoreCommit();
      const profile = await this.profile();
      const backupHash = createHash('sha256').update(bytes).digest('hex');
      if (pending && pending.backupHash !== backupHash) throw new PodError('Choose the same backup to finish this interrupted restore.');
      if (pending && profile && (profile.keyFingerprint !== pending.keyFingerprint || profile.baseUrl !== pending.baseUrl)) {
        throw new PodError('The interrupted restore does not match the current pod settings. Your data was kept unchanged.');
      }
      if (!pending && (profile || this.node || await exists(this.storeDir) || await this.vault.load())) {
        throw new PodError('Restore notes on a new pod. Your existing pod was kept unchanged.');
      }
      // Validate and authenticate every record before creating local state. Backup data never
      // supplies paths or archive entries; records are republished through the normal publisher.
      const snapshot = await this.openBackup(bytes, phrase);
      if (pending && pending.keyFingerprint !== fingerprint(snapshot.contentKey)) throw new PodError('This backup does not match the interrupted restore.');
      this.state = 'starting';
      await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
      const staging = pending ? join(this.dataDir, pending.stagingName) : await mkdtemp(join(this.dataDir, '.restore-'));
      let staged: LocalNode | undefined;
      try {
        let commit = pending;
        if (!commit) {
          staged = await launchLocal(resolveDeploymentConfig({ profile: 'local', dataDir: join(staging, 'store') }), { port: 0, startupTimeoutMs: 120_000 });
          for (const note of snapshot.notes) await this.publishNote(staged, snapshot.contentKey, note);
          if ((await this.readNotes(staged, snapshot.contentKey)).length !== snapshot.notes.length) throw new Error('restore verification');
          commit = { version: 1, backupHash, baseUrl: staged.baseUrl, keyFingerprint: fingerprint(snapshot.contentKey), stagingName: staging.slice(this.dataDir.length + 1) };
          await staged.stop(); staged = undefined;
          await this.saveJson(this.restorePath, commit);
        }
        const destinationExists = await exists(this.storeDir);
        const sourceExists = await exists(join(staging, 'store'));
        if ((destinationExists && sourceExists) || (!destinationExists && !sourceExists)) throw new PodError('The restore has conflicting local folders. Your stored data was kept unchanged.');
        const folder = await lstat(destinationExists ? this.storeDir : join(staging, 'store'));
        if (!folder.isDirectory() || folder.isSymbolicLink()) throw new PodError('The restore folder could not be verified. Your stored data was kept unchanged.');
        const currentKey = await this.vault.load();
        if (currentKey && fingerprint(keyPair(currentKey)) !== commit.keyFingerprint) throw new PodError('Another pod key is present. Your stored data was kept unchanged.');
        await this.vault.save(snapshot.contentKey);
        if (!destinationExists) await rename(join(staging, 'store'), this.storeDir);
        await this.saveProfile({ version: 1, baseUrl: commit.baseUrl, keyFingerprint: commit.keyFingerprint });
        await unlink(this.restorePath);
        await this.startInternal();
        return this.getStatus();
      } finally {
        await staged?.stop();
        // Only the empty staging parent is removed here; no backup-supplied path is ever used.
        try { await rmdir(staging); } catch { /* Failed staging remains encrypted for diagnosis. */ }
      }
    });
  }
}
