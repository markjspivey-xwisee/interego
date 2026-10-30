import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, safeStorage, shell, type IpcMainInvokeEvent } from 'electron';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { Socket } from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { EncryptionKeyPair } from '@interego/core';
import { PodController } from './controller.js';
import { waitForProtectedStorage } from './protected-storage-ready.js';
import type { FileActionResult, LocalNote, NoteInput, PodStatus } from './types.js';
import { readBackupFile } from './read-backup.js';
import { AgentService } from './agent-service.js';
import type { AgentConnectionInput, AgentProtector } from './agent-types.js';
import { buildAgentSetup } from './agent-setup.js';
import { BridgeServer } from './bridge-server.js';
import { StableBridgeTunnel } from './stable-tunnel.js';
import { StableBridgeStore } from './stable-bridge.js';
import { BridgeManager } from './bridge-manager.js';
import type { BridgeClient, BridgeStartInput, StableBridgeInput } from './bridge-types.js';
import { BrowserExtensionStore, extensionIds } from './browser-extensions.js';
import { LocalIdentityService, ProtectedLocalIdentityStore } from './local-identity.js';
import { IdentityBrowser } from './identity-browser.js';
import { NativeIdentityHost } from './native-identity-host.js';
import { IdentityBrowserPolicy } from './identity-browser-policy.js';
import { FederationService, ProtectedFederationStore } from '@interego/pod-federation';
import { presentSharedResource } from './federation-notes.js';
import { shareSelectedNotes } from './federation-owner.js';

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, '..', 'index.html');
const entryUrl = pathToFileURL(entry).href;
const agentMode = process.argv.includes('--mcp-stdio') || app.commandLine.hasSwitch('mcp-stdio');
const smoke = !agentMode && process.env['INTEREGO_POD_SMOKE'] === '1';
const trace = (phase: string): void => {
  if (!agentMode && (smoke || process.env['INTEREGO_POD_DIAGNOSTICS'] === '1')) process.stdout.write(`[Interego] ${phase}\n`);
};
trace('main module loaded');
function argument(name: string): string | undefined {
  const switchValue = app.commandLine.getSwitchValue(name.slice(2));
  if (switchValue) return switchValue;
  const matches = process.argv.flatMap((value, index) => value === name ? [index] : []);
  if (matches.length > 1) throw new Error('The local agent command has repeated arguments. Copy its setup again.');
  if (!matches.length) return undefined;
  const value = process.argv[matches[0]! + 1];
  if (!value || value.startsWith('--')) throw new Error('The local agent command is incomplete. Copy its setup again.');
  return value;
}
const override = agentMode ? argument('--pod-data-dir') ?? process.env['INTEREGO_POD_DATA_DIR']
  : smoke ? process.env['INTEREGO_POD_SMOKE_DATA'] : process.env['INTEREGO_POD_DATA_DIR'];
app.setName('Interego');
if (smoke && !override) throw new Error('Packaged verification requires an isolated data directory.');
if (override) {
  if (!isAbsolute(override)) throw new Error('Interego data directory must be absolute.');
  app.setPath('userData', override);
}
if (smoke || agentMode) app.disableHardwareAcceleration();

let window: BrowserWindow | null = null;
let controller: PodController | undefined;
let agentService: AgentService | undefined;
let webBridge: BridgeManager | undefined;
let podFederation: FederationService | undefined;
let localIdentity: LocalIdentityService | undefined;
let identityBrowser: IdentityBrowser | undefined;
let identityBrowserError: string | undefined;
let federationGeneration = 0;
let smokeBridgeOrigin: string | undefined;
let smokeFederationPeer: FederationService | undefined;
let pairingError: string | undefined;
let closing = false;
const pending = new Set<Promise<unknown>>();

async function atomicWrite(path: string, value: Uint8Array): Promise<void> {
  const temporary = `${path}.tmp-${randomUUID()}`;
  let written = false;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(value); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, path);
    written = true;
  } finally {
    if (!written) await unlink(temporary).catch(() => {});
  }
}

function requireProtection(): void {
  if (!safeStorage.isEncryptionAvailable()
    || (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) {
    throw new Error('Your computer’s protected key storage is unavailable. Your pod has not been changed.');
  }
}

const agentProtector: AgentProtector = {
  protect(value) { requireProtection(); return safeStorage.encryptString(value).toString('base64'); },
  unprotect(value) { requireProtection(); return safeStorage.decryptString(Buffer.from(value, 'base64')); },
};

function keyVault(userData: string) {
  const directory = join(userData, 'vault');
  const path = join(directory, 'notes-key.bin');
  return {
    async load(): Promise<EncryptionKeyPair | null> {
      let bytes: Buffer;
      try { bytes = await readFile(path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
      requireProtection();
      try {
        const key = JSON.parse(safeStorage.decryptString(bytes)) as EncryptionKeyPair;
        if (key.algorithm !== 'X25519-XSalsa20-Poly1305'
          || Buffer.from(key.publicKey, 'base64').length !== 32
          || Buffer.from(key.secretKey, 'base64').length !== 32) throw new Error('invalid key');
        return key;
      } catch {
        throw new Error('Windows could not unlock this pod’s key. Use the Windows account that created it, or restore your notes backup in a fresh installation.');
      }
    },
    async save(key: EncryptionKeyPair): Promise<void> {
      requireProtection();
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const existing = await this.load();
      if (existing) {
        if (existing.publicKey !== key.publicKey || existing.secretKey !== key.secretKey) {
          throw new Error('This installation already holds a different pod key. Existing notes have not been replaced.');
        }
        return;
      }
      await atomicWrite(path, safeStorage.encryptString(JSON.stringify(key)));
    },
  };
}

function trusted(event: IpcMainInvokeEvent): boolean {
  return Boolean(window && event.sender === window.webContents
    && event.senderFrame === window.webContents.mainFrame && event.senderFrame.url === entryUrl);
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (/EADDRINUSE|address.*in use/i.test(message)) return 'Another app is using the local pod’s address. Close the other app and try again.';
  if (/locked|another.*process|already running/i.test(message)) return 'This pod is open in another Interego process. Close it and try again. Your saved notes are safe.';
  if (/Could not build|componentsjs|fetch failed|ECONNREFUSED|ENOENT/i.test(message)) return 'The local pod could not start. Try again, or reinstall Interego. Your saved notes stay in your data folder.';
  // Errors from the controller are designed for the user; never forward stacks or arbitrary objects.
  return message && message.length <= 350 && !/[\\/](?:Users|node_modules|packages)[\\/]/i.test(message)
    ? message : 'Something went wrong. Your saved notes have not been deleted. Please try again.';
}

function handle(operation: string, action: (argument: unknown) => Promise<unknown>): void {
  ipcMain.handle(`pod:${operation}`, async (event, argument: unknown) => {
    if (!trusted(event) || closing) return { ok: false, error: 'This Interego window is not available. Reopen the app and try again.' };
    const task = action(argument);
    pending.add(task);
    try { return { ok: true, value: await task }; }
    catch (error) { return { ok: false, error: errorMessage(error) }; }
    finally { pending.delete(task); }
  });
}

function passphrase(value: unknown): string {
  if (typeof value !== 'string' || value.length < 12 || value.length > 1024) {
    throw new Error('Use a backup passphrase with at least 12 characters.');
  }
  return value;
}

function connections(): AgentService {
  if (!agentService) throw new Error(pairingError ?? 'Agent connections are unavailable. Reopen Interego and try again.');
  return agentService;
}

function bridge(): BridgeManager {
  if (!webBridge) throw new Error('Web connections are unavailable. Reopen Interego and try again. Your local notes are safe.');
  return webBridge;
}

function sharing(): FederationService {
  if (!podFederation) throw new Error('Pod sharing is unavailable. Reopen Interego to try again.');
  return podFederation;
}

async function pauseFederation(): Promise<void> {
  ++federationGeneration;
  await podFederation?.setEnabled(false).catch(() => {}); // Disable aborts synchronously even when saved state needs recovery.
}

async function federationFlags(): Promise<{ localOnly: boolean; federationEnabled: boolean }> {
  // Unreadable sharing state must not prevent access to the authoritative local pod.
  const enabled = await podFederation?.status().then(value => value.enabled).catch(() => false) ?? false;
  return { localOnly: !enabled, federationEnabled: enabled };
}

function approvalId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{16,128}$/.test(value)) throw new Error('Choose a pending connection request.');
  return value;
}

async function connectionSetup(id: unknown) {
  if (typeof id !== 'string') throw new Error('Choose an agent connection.');
  const connection = await connections().get(id);
  if (!['waiting', 'active'].includes(connection.state)) throw new Error('This connection is no longer available. Create a new connection to continue.');
  return buildAgentSetup(connection, { command: process.execPath, args: app.isPackaged ? [] : [app.getAppPath()] }, app.getPath('userData'));
}

async function bootstrap(): Promise<void> {
  trace('waiting for Electron');
  await app.whenReady();
  trace('Electron ready');
  if (process.platform === 'win32') {
    requireProtection();
    safeStorage.encryptString('Interego protected storage readiness');
    await waitForProtectedStorage(app.getPath('sessionData'));
  }
  Menu.setApplicationMenu(null);
  const userData = app.getPath('userData');
  await mkdir(userData, { recursive: true, mode: 0o700 });
  const options = { dataDir: join(userData, 'local-pod'), vault: keyVault(userData) };
  controller = new PodController(options);
  const pod = controller;
  const extensions = new BrowserExtensionStore(join(userData, 'browser-access'), agentProtector);
  const identityExtensions = new BrowserExtensionStore(join(userData, 'identity-browser', 'allowed-extensions'), agentProtector);
  const identitySmoke = smoke ? (await import('./identity-smoke.js')).createIdentitySmoke() : undefined;
  localIdentity = new LocalIdentityService({
    store: new ProtectedLocalIdentityStore({ dataDir: join(userData, 'local-identity'), protector: agentProtector }),
    binding: () => controller!.agentPodBinding(),
    trustedRelays: [{ relayOrigin: 'https://relay.interego.xwisee.com', identityOrigin: 'https://identity.interego.xwisee.com' }],
    ...(identitySmoke ? { fetch: identitySmoke.fetch } : {}),
  });
  const identity = localIdentity;
  const nativeIdentityHost = new NativeIdentityHost({ dataDir: join(userData, 'identity-browser'),
    executable: join(app.getAppPath(), 'dist', 'native-host', 'Interego-Identity.exe') });
  let identityAdmission = true;
  const identityPolicy = new IdentityBrowserPolicy({
    saveAllowed: ids => identityExtensions.save(ids), configureHost: ids => nativeIdentityHost.configure(ids), closing: () => closing,
    revoke: () => { identityAdmission = false; identityBrowser?.revokeChannels(); },
    allowAdmission: () => { identityAdmission = true; },
  });
  if (process.platform === 'win32') {
    const browser = new IdentityBrowser({ dataDir: join(userData, 'identity-browser'), service: identity,
      allowedOrigins: () => identityAdmission ? identityExtensions.origins() : Promise.resolve([]), protectTicket: value => nativeIdentityHost.protectTicket(value),
      onPending: () => { if (!smoke && window && !window.isDestroyed()) { window.restore(); window.show(); window.focus(); } },
    });
    try { await browser.start(); identityBrowser = browser; }
    catch { identityBrowserError = 'Local browser sign-in could not open. Reopen Interego or reinstall this Windows preview.'; await browser.close().catch(() => {}); }
  }
  handle('localIdentityStatus', async () => identity.status());
  handle('setupLocalIdentity', async () => identity.setup());
  handle('approveLocalIdentity', async value => {
    if (!value || typeof value !== 'object') throw new Error('Choose a pending sign-in.');
    const input = value as { id?: unknown; verificationCode?: unknown };
    if (typeof input.id !== 'string' || typeof input.verificationCode !== 'string') throw new Error('Choose a pending sign-in and check its code.');
    await identity.approve(input.id, input.verificationCode); return identity.status();
  });
  handle('denyLocalIdentity', async value => {
    if (typeof value !== 'string') throw new Error('Choose a pending sign-in.');
    identity.deny(value); return identity.status();
  });
  handle('forgetLocalIdentity', async () => identity.forget());
  handle('identityExtensionIds', async () => identityExtensions.list());
  handle('setIdentityExtensionIds', async value => {
    const ids = extensionIds(value);
    if (!identityBrowser) throw new Error(identityBrowserError ?? 'Local browser sign-in is available in the Windows preview.');
    if (userData.toLowerCase() !== join(app.getPath('appData'), 'Interego').toLowerCase()) {
      throw new Error('Browser registration is available in the standard installed Interego data folder. This isolated profile has not been registered.');
    }
    return identityPolicy.save(ids);
  });
  handle('backupLocalIdentity', async value => {
    const phrase = passphrase(value);
    const chosen = await dialog.showSaveDialog(window!, { title: 'Back up your local sign-in identity',
      defaultPath: 'Interego-identity.interego-identity', filters: [{ name: 'Encrypted Interego identity', extensions: ['interego-identity'] }] });
    if (!chosen.canceled && chosen.filePath) await atomicWrite(chosen.filePath, await identity.exportBackup(phrase));
    // A valid recovery export can succeed even when its old notes pod is unavailable.
    return { cancelled: chosen.canceled || !chosen.filePath, status: await identity.status().catch(() => ({ configured: true, pending: [] })) };
  });
  handle('restoreLocalIdentity', async value => {
    const phrase = passphrase(value);
    const chosen = await dialog.showOpenDialog(window!, { title: 'Restore your local sign-in identity', properties: ['openFile'],
      filters: [{ name: 'Encrypted Interego identity', extensions: ['interego-identity'] }] });
    if (!chosen.canceled && chosen.filePaths[0]) {
      const file = await open(chosen.filePaths[0], 'r');
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > 32 * 1024) throw new Error('Choose an encrypted Interego identity backup, up to 32 KB.');
        const bytes = Buffer.alloc(32 * 1024 + 1); let size = 0;
        while (size < bytes.length) { const result = await file.read(bytes, size, bytes.length - size, null); if (!result.bytesRead) break; size += result.bytesRead; }
        if (size > 32 * 1024) throw new Error('This identity backup is too large.');
        await identity.restoreBackup(bytes.subarray(0, size), phrase);
      } finally { await file.close(); }
    }
    return { cancelled: chosen.canceled || !chosen.filePaths[0], status: await identity.status() };
  });
  const smokeFederationTransport: typeof fetch = async (input, init) => {
    if (!smoke) throw new Error('The isolated peer transport is unavailable.');
    const request = new Request(input, init); const url = new URL(request.url);
    if (url.origin === 'https://packaged-peer.example' && smokeFederationPeer) return smokeFederationPeer.handle(request);
    if (url.origin !== 'https://packaged-stable.example' || !smokeBridgeOrigin) throw new Error('Unknown isolated peer address.');
    return fetch(`${smokeBridgeOrigin}${url.pathname}`, { method: request.method, headers: request.headers,
      body: request.method === 'POST' ? await request.text() : undefined, signal: request.signal, redirect: 'error' });
  };
  podFederation = new FederationService({
    store: new ProtectedFederationStore({ dataDir: join(userData, 'pod-federation'), protector: agentProtector }),
    binding: () => controller!.agentPodBinding(),
    ...(smoke ? { fetch: smokeFederationTransport } : {}),
  });
  if (smoke) smokeFederationPeer = new FederationService({
    store: new ProtectedFederationStore({ dataDir: join(userData, 'smoke-independent-peer'), protector: agentProtector }),
    binding: async () => 'isolated-independent-peer', fetch: smokeFederationTransport,
  });
  const access = new AgentService({ dataDir: join(userData, 'agent-access'), protector: agentProtector,
    getPodBinding: () => controller!.agentPodBinding(), execute: async (operation, args, authorize) => {
      const result = await controller!.executeAgent(operation, args ?? {}, authorize);
      return operation === 'status' ? { ...(result as Record<string, unknown>), ...await federationFlags() } : result;
    } });
  try { await access.start(); agentService = access; }
  catch {
    pairingError = 'Agent connections could not open. Your saved notes are safe. Reopen Interego to try again.';
    await access.close().catch(() => {});
  }
  if (agentService) {
    const server = new BridgeServer({ agents: access, allowedBrowserOrigins: () => extensions.origins(),
      federation: request => sharing().handle(request), persistence: {
      dataDir: join(userData, 'web-bridge', 'authorization'), protector: agentProtector,
      getPodBinding: () => controller!.agentPodBinding(),
    } });
    const settings = new StableBridgeStore({ dataDir: join(userData, 'web-bridge', 'settings'), protector: agentProtector });
    const tunnel = smoke ? {
      // The packaged offline check exercises real HTTP/OAuth and trusted IPC,
      // while deliberately replacing the external provider with an isolated URL.
      async start(port: number, stable?: { origin: string }) { smokeBridgeOrigin = `http://127.0.0.1:${port}`; return stable?.origin ?? 'https://packaged-verification.trycloudflare.com'; },
      async stop() { smokeBridgeOrigin = undefined; },
    } : new StableBridgeTunnel({
      resourcesDir: app.isPackaged ? app.getAppPath() : join(app.getAppPath(), '.staging', 'app'),
      dataDir: join(userData, 'web-bridge'),
      onUnexpectedExit: () => { void pauseFederation().then(() => webBridge?.connectionLost()).catch(() => {}); },
    });
    // Construction does not bind a port, launch a tunnel or restore web access.
    webBridge = new BridgeManager(server, tunnel, { settings, ...(smoke ? { verifyPublic: async () => {} } : {}) });
  }
  handle('status', async () => ({ ...await pod.getStatus(), ...await federationFlags() }));
  handle('setup', async () => pod.setup());
  handle('start', async () => pod.start());
  handle('stop', async () => {
    // The owner's Stop control closes remote access as well as local storage.
    try { await pauseFederation(); await webBridge?.stop(); }
    finally { await pod.stop(); }
    return pod.getStatus();
  });
  handle('notes', async () => pod.listNotes());
  handle('saveNote', async value => pod.saveNote(value as NoteInput));
  handle('connections', async () => connections().list());
  handle('createConnection', async value => {
    const state = await pod.getStatus();
    if (!state.configured || state.restorePending) throw new Error('Finish setting up or restoring your local pod before connecting an app.');
    return connections().create(value as AgentConnectionInput);
  });
  handle('revokeConnection', async value => {
    if (typeof value !== 'string') throw new Error('Choose an agent connection.');
    await connections().revoke(value);
  });
  handle('connectionSetup', connectionSetup);
  handle('copyConnectionSetup', async value => {
    if (!value || typeof value !== 'object') throw new Error('Choose setup instructions to copy.');
    const input = value as { id?: unknown; format?: unknown };
    if (input.format !== 'configuration' && input.format !== 'command') throw new Error('Choose a setup format.');
    const setup = await connectionSetup(input.id);
    const text = input.format === 'command' ? setup.command : setup.configuration;
    if (!text) throw new Error('This connection uses configuration settings. Copy those settings instead.');
    clipboard.writeText(text);
  });
  handle('bridgeStatus', async () => bridge().status());
  handle('startBridge', async value => {
    const state = await pod.getStatus();
    if (!state.running || !state.configured || state.restorePending) throw new Error('Start your local space before connecting a web app.');
    return bridge().start(value as BridgeStartInput);
  });
  handle('stopBridge', async () => { await pauseFederation(); return bridge().stop(); });
  handle('approveBridge', async value => bridge().approve(approvalId(value)));
  handle('denyBridge', async value => bridge().deny(approvalId(value)));
  handle('copyBridgeUrl', async () => {
    const state = await bridge().status();
    if (!state.url || (state.state !== 'ready' && !state.remembered)) throw new Error('Set up your web connection before copying its link.');
    clipboard.writeText(state.url);
  });
  handle('stableBridgeSettings', async () => bridge().settings());
  handle('saveStableBridge', async value => {
    const state = await pod.getStatus();
    if (!state.configured || state.restorePending) throw new Error('Finish setting up your local space before saving its web address.');
    return bridge().save(value as StableBridgeInput);
  });
  handle('resumeBridge', async () => {
    const state = await pod.getStatus();
    if (!state.running || state.restorePending) throw new Error('Start your local space before enabling web access.');
    return bridge().resume();
  });
  handle('forgetStableBridge', async () => { await pauseFederation(); return bridge().forget(); });
  handle('copyStableBridgeTarget', async () => {
    const saved = await bridge().settings();
    if (!saved) throw new Error('Save a permanent address before copying its local target.');
    clipboard.writeText(`http://127.0.0.1:${saved.port}`);
  });
  handle('openStableBridgeSetup', async () => shell.openExternal('https://one.dash.cloudflare.com/'));
  handle('browserExtensionIds', async () => extensions.list());
  handle('setBrowserExtensionIds', async value => extensions.save(value));
  handle('federationStatus', async () => sharing().status());
  handle('enableFederation', async value => {
    if (typeof value !== 'string' || !value.trim() || value.length > 80) throw new Error('Give your pod a name of up to 80 characters.');
    const generation = ++federationGeneration;
    const state = await pod.getStatus();
    const saved = await bridge().settings();
    if (!state.running || state.restorePending) throw new Error('Start your local pod before enabling sharing.');
    if (!saved) throw new Error('Save a permanent web address above before enabling pod sharing.');
    const current = () => {
      if (closing || generation !== federationGeneration) throw new Error('Pod sharing was paused. Enable it again when you are ready.');
    };
    current();
    await sharing().configure({ name: value.trim(), endpoint: `${saved.origin}/pod-federation`, kind: 'local' });
    current();
    const before = await bridge().status(); current();
    if (before.state !== 'ready') throw new Error('Enable your permanent web address above before turning on pod sharing. This also lets you review any saved assistant connections.');
    const enabled = await sharing().setEnabled(true);
    if (generation !== federationGeneration || closing) { await sharing().setEnabled(false); current(); }
    return enabled;
  });
  handle('disableFederation', async () => { await pauseFederation(); return sharing().status(); });
  handle('createFederationInvite', async () => sharing().createInvite());
  handle('copyFederationInvite', async value => {
    if (typeof value !== 'string' || !value || value.length > 16384 || /[\u0000-\u0020\u007f]/.test(value)) throw new Error('Create an invitation before copying it.');
    clipboard.writeText(value);
  });
  handle('acceptFederationInvite', async value => {
    if (typeof value !== 'string') throw new Error('Paste the invitation from the person you want to connect with.');
    return sharing().acceptInvite(value);
  });
  handle('approveFederation', async value => {
    if (!value || typeof value !== 'object') throw new Error('Choose a pending pod invitation.');
    const input = value as { id?: unknown; verificationCode?: unknown };
    if (typeof input.id !== 'string' || typeof input.verificationCode !== 'string') throw new Error('Compare the invitation codes before accepting.');
    return sharing().approve(input.id, input.verificationCode);
  });
  handle('denyFederation', async value => { if (typeof value !== 'string') throw new Error('Choose an invitation.'); return sharing().deny(value); });
  handle('refreshFederation', async () => sharing().refresh());
  handle('shareFederation', async value => {
    if (!value || typeof value !== 'object') throw new Error('Choose a connection and the notes to share.');
    const input = value as { peerId?: unknown; noteIds?: unknown };
    if (typeof input.peerId !== 'string' || !Array.isArray(input.noteIds) || input.noteIds.some(id => typeof id !== 'string')) throw new Error('Choose saved notes to share.');
    return shareSelectedNotes({ generation: () => federationGeneration, closing: () => closing,
      resources: ids => pod.federationResources(ids), share: (peerId, resources) => sharing().share(peerId, resources) }, input.peerId, input.noteIds as string[]);
  });
  handle('readFederation', async value => { if (typeof value !== 'string') throw new Error('Choose a received snapshot.'); return presentSharedResource(await sharing().received(value)); });
  handle('revokeFederation', async value => { if (typeof value !== 'string') throw new Error('Choose a connected pod.'); return sharing().revoke(value); });
  handle('forgetFederation', async () => { ++federationGeneration; return sharing().forget(); });
  handle('removeFederationSnapshot', async value => { if (typeof value !== 'string') throw new Error('Choose a received snapshot.'); return sharing().removeReceived(value); });
  handle('clearFederationHistory', async () => sharing().clearSentHistory());
  handle('openBridgeClient', async value => {
    const links: Record<BridgeClient, string> = {
      'chatgpt-web': 'https://chatgpt.com/',
      'grok-bot': 'https://grok.com/',
      'other-web': 'https://modelcontextprotocol.io/',
    };
    if (typeof value !== 'string' || !Object.hasOwn(links, value)) throw new Error('Choose a supported web app.');
    await shell.openExternal(links[value as BridgeClient]);
  });
  handle('openDataFolder', async () => {
    const result = await shell.openPath(userData);
    if (result) throw new Error('Your data folder could not be opened. Please try again.');
  });
  handle('openHosted', async () => {
    await shell.openExternal('https://identity.interego.xwisee.com/dashboard');
  });
  handle('backup', async value => {
    const phrase = passphrase(value);
    const choice = await dialog.showSaveDialog(window!, {
      title: 'Back up your private notes',
      defaultPath: join(app.getPath('documents'), `Interego-notes-${new Date().toISOString().slice(0, 10)}.interego`),
      filters: [{ name: 'Encrypted Interego notes backup', extensions: ['interego'] }],
    });
    if (choice.canceled || !choice.filePath) return { cancelled: true, status: await pod.getStatus() } satisfies FileActionResult;
    const bytes = await pod.exportBackup(phrase);
    await atomicWrite(choice.filePath, bytes);
    return { cancelled: false, status: await pod.getStatus() } satisfies FileActionResult;
  });
  handle('restore', async value => {
    const phrase = passphrase(value);
    const state = await pod.getStatus();
    if (state.configured && !state.restorePending) throw new Error('Restore is available before setting up a pod, so your existing notes are never overwritten.');
    const choice = await dialog.showOpenDialog(window!, {
      title: 'Restore your private notes', properties: ['openFile'],
      filters: [{ name: 'Encrypted Interego notes backup', extensions: ['interego'] }],
    });
    if (choice.canceled || !choice.filePaths[0]) return { cancelled: true, status: await pod.getStatus() } satisfies FileActionResult;
    const source = choice.filePaths[0];
    await pod.restoreBackup(await readBackupFile(source), phrase);
    return { cancelled: false, status: await pod.getStatus() } satisfies FileActionResult;
  });

  window = new BrowserWindow({
    width: 1100, height: 790, minWidth: 860, minHeight: 650, title: 'Interego',
    backgroundColor: '#f4f6f3', icon: join(here, '..', 'assets', 'icon.png'),
    show: !smoke, autoHideMenuBar: true,
    webPreferences: { preload: join(here, 'preload.cjs'), contextIsolation: true, sandbox: true,
      nodeIntegration: false, webSecurity: true, webviewTag: false, navigateOnDragDrop: false },
  });
  trace('window created');
  window.on('closed', () => { window = null; });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_details, callback) => callback({ cancel: true }));
  await window.loadFile(entry);
  trace('window loaded');
  if (closing) return;
  if (smoke) {
    const original = Socket.prototype.connect;
    let outbound = 0;
    Socket.prototype.connect = function (this: Socket, ...args: unknown[]): Socket {
      const first = Array.isArray(args[0]) ? args[0][0] : args[0];
      const value = first && typeof first === 'object' ? first as { path?: string; host?: string; hostname?: string } : null;
      if (typeof first !== 'string' && !value?.path) {
        const host = value?.host ?? value?.hostname ?? (typeof args[1] === 'string' ? args[1] : 'localhost');
        if (!['localhost', '127.0.0.1', '::1', '[::1]', '::ffff:127.0.0.1'].includes(host)) {
          outbound++; throw new Error('Packaged offline verification refused a remote connection.');
        }
      }
      return Reflect.apply(original, this, args) as Socket;
    } as typeof Socket.prototype.connect;
    try {
      const firstScreen = await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
        const deadline = Date.now() + 15000;
        const check = () => {
          const loading = document.getElementById('loading-screen');
          const welcome = document.getElementById('welcome');
          const shell = document.getElementById('shell');
          const setup = document.getElementById('setup-local');
          if (loading?.hidden && welcome && shell && welcome.hidden !== shell.hidden
            && (welcome.hidden || (setup && !setup.disabled)) && document.getElementById('identity-backup-dialog')) {
            resolve({ configured: !shell.hidden });
          } else if (Date.now() >= deadline) reject(new Error('The packaged app did not reach its usable first screen.'));
          else setTimeout(check, 50);
        };
        check();
      })`) as { configured: boolean };
      process.stdout.write(`INTEREGO_POD_UI_READY:${firstScreen.configured ? 'space' : 'welcome'}\n`);
      // Exercise the shipping sandboxed preload and trusted renderer IPC, too.
      const initial = await window.webContents.executeJavaScript('window.interego.status()') as PodStatus;
      if (!initial.localOnly || initial.federationEnabled || firstScreen.configured !== initial.configured) throw new Error('The packaged renderer bridge has an invalid local profile.');
      const bridgeStatus = await window.webContents.executeJavaScript('window.interego.bridgeStatus()') as { state: string; url?: string; remembered?: boolean; pendingApprovals: unknown[]; connections: unknown[] };
      if (bridgeStatus.state !== 'off' || bridgeStatus.pendingApprovals.length
        || (!initial.configured && (bridgeStatus.url || bridgeStatus.remembered || bridgeStatus.connections.length))) throw new Error('Web connections must start disabled on every app launch.');
      await window.webContents.executeJavaScript(initial.configured ? 'window.interego.start()' : 'window.interego.setup()');
      const note = await window.webContents.executeJavaScript('window.interego.saveNote({title:"Packaged local pod verification",body:"This private note survives a packaged runtime restart."})') as LocalNote;
      const { verifyAgentPairing } = await import('./pairing-smoke.js');
      const pairedNoteId = await verifyAgentPairing({ command: process.execPath, args: app.isPackaged ? [] : [app.getAppPath()], userData,
        packaged: app.isPackaged, expectPrevious: initial.configured,
        create: input => window!.webContents.executeJavaScript(`window.interego.createConnection(${JSON.stringify(input)})`),
        revoke: id => window!.webContents.executeJavaScript(`window.interego.revokeConnection(${JSON.stringify(id)})`),
        list: () => window!.webContents.executeJavaScript('window.interego.connections()'),
        notes: () => window!.webContents.executeJavaScript('window.interego.notes()') });
      const { verifyWebBridge } = await import('./bridge-smoke.js');
      const smokeInvoke = <T>(method: string, argument?: unknown) => window!.webContents.executeJavaScript(`window.interego[${JSON.stringify(method)}](${argument === undefined ? '' : JSON.stringify(argument)})`) as Promise<T>;
      await identitySmoke!.verify({ invoke: smokeInvoke, executable: join(app.getAppPath(), 'dist/native-host/Interego-Identity.exe'),
        approve: (id, code) => window!.webContents.executeJavaScript(`window.interego.approveLocalIdentity(${JSON.stringify(id)},${JSON.stringify(code)})`),
        dataDir: userData, allow: ids => identityExtensions.save(ids), expectPrevious: initial.configured });
      if (!initial.configured) await verifyWebBridge({ invoke: smokeInvoke, loopback: () => smokeBridgeOrigin });
      const { verifyStableBridge } = await import('./stable-bridge-smoke.js');
      const { verifyFederation } = await import('./federation-smoke.js');
      const checkFederation = () => verifyFederation({ invoke: smokeInvoke, loopback: () => smokeBridgeOrigin,
        expectPrevious: initial.configured, peer: smokeFederationPeer!,
        approve: (id, code) => window!.webContents.executeJavaScript(`window.interego.approveFederation(${JSON.stringify(id)},${JSON.stringify(code)})`),
        save: async value => atomicWrite(join(userData, 'smoke-peer-journal.bin'), Buffer.from(agentProtector.protect(JSON.stringify(value)), 'utf8')),
        load: async () => JSON.parse(agentProtector.unprotect(await readFile(join(userData, 'smoke-peer-journal.bin'), 'utf8'))) as import('./federation-smoke.js').FederationSmokeJournal });
      if (initial.configured) await checkFederation();
      await verifyStableBridge({ invoke: smokeInvoke, loopback: () => smokeBridgeOrigin, expectPrevious: initial.configured,
        saveClient: async client => atomicWrite(join(userData, 'smoke-web-client.bin'), Buffer.from(agentProtector.protect(JSON.stringify(client)), 'utf8')),
        loadClient: async () => JSON.parse(agentProtector.unprotect(await readFile(join(userData, 'smoke-web-client.bin'), 'utf8'))) as import('./stable-bridge-smoke.js').SavedSmokeClient });
      if (!initial.configured) await checkFederation();
      await window.webContents.executeJavaScript('window.interego.stop()');
      const reopened = new PodController(options);
      controller = reopened;
      await reopened.start();
      const notes = await reopened.listNotes();
      const status = await reopened.getStatus();
      if (!notes.some(item => item.id === note.id && item.body === note.body) || !notes.some(item => item.id === pairedNoteId && item.author)
        || status.federationEnabled || outbound) {
        throw new Error('Packaged offline persistence verification failed.');
      }
      await reopened.stop();
      process.stdout.write('INTEREGO_POD_SMOKE_OK\n');
    } finally { Socket.prototype.connect = original; }
    app.quit();
  } else {
    const state = await pod.getStatus();
    if (state.configured && !state.restorePending) {
      void pod.start().catch(() => {}); // State and a retry action are presented in the local dashboard.
    }
  }
}

if (agentMode) {
  void (async () => {
    await app.whenReady();
    const connectionId = argument('--connection');
    if (!connectionId) throw new Error('Choose a local agent connection. Copy its setup from Interego.');
    const { runAgentStdio } = await import('./agent-stdio.js');
    // Electron's Windows main-process stdin is a dummy Readable. Read the
    // inherited pipe itself so MCP messages and a real client EOF both work.
    const input = createReadStream('', { fd: 0, autoClose: false });
    const companion = await runAgentStdio({ dataDir: join(app.getPath('userData'), 'agent-access'), connectionId, protector: agentProtector, input });
    await companion.closed;
    await companion.close();
    app.exit(0);
  })().catch(error => {
    if (process.env['INTEREGO_POD_DIAGNOSTICS'] === '1') process.stderr.write(`Interego companion diagnostic: ${error instanceof Error ? error.stack : 'startup failed'}\n`);
    process.stderr.write('Interego could not open this local agent connection. Open the app and copy its setup again.\n'); app.exit(1);
  });
}
else if (!app.requestSingleInstanceLock()) { trace('another instance owns this space'); app.quit(); }
else {
  app.on('second-instance', () => { if (window && !window.isDestroyed()) { window.restore(); window.show(); window.focus(); } });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (closing) return;
    event.preventDefault(); closing = true;
    void (async () => {
      try {
        // Stop admitting agent work before waiting for any owner dialog or action.
        localIdentity?.stop();
        const identityClosing = identityBrowser?.close();
        trace('closing web connections');
        await pauseFederation();
        await webBridge?.stop();
        trace('closing local app connections');
        await identityClosing;
        await agentService?.close();
        trace('finishing owner actions');
        await Promise.allSettled([...pending]);
        trace('closing local storage');
        await controller?.stop();
        trace('shutdown complete');
        app.exit(0);
      }
      catch { app.exit(1); }
    })();
  });
  void bootstrap().catch(error => {
    if (smoke) { process.stderr.write(`INTEREGO_POD_SMOKE_FAILED: ${errorMessage(error)}\n`); app.exit(1); }
    else void dialog.showMessageBox({ type: 'error', title: 'Interego could not open', message: errorMessage(error) }).then(() => app.quit());
  });
}
