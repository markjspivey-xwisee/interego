import { app, BrowserWindow, dialog, ipcMain, Menu, safeStorage, shell, type IpcMainInvokeEvent } from 'electron';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { Socket } from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { EncryptionKeyPair } from '@interego/core';
import { PodController } from './controller.js';
import type { FileActionResult, LocalNote, NoteInput, PodStatus } from './types.js';
import { readBackupFile } from './read-backup.js';

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, '..', 'index.html');
const entryUrl = pathToFileURL(entry).href;
const smoke = process.env['INTEREGO_POD_SMOKE'] === '1';
const trace = (phase: string): void => { if (smoke || process.env['INTEREGO_POD_DIAGNOSTICS'] === '1') process.stdout.write(`[Interego] ${phase}\n`); };
trace('main module loaded');
const override = smoke ? process.env['INTEREGO_POD_SMOKE_DATA'] : process.env['INTEREGO_POD_DATA_DIR'];
app.setName('Interego');
if (smoke && !override) throw new Error('Packaged verification requires an isolated data directory.');
if (override) {
  if (!isAbsolute(override)) throw new Error('Interego data directory must be absolute.');
  app.setPath('userData', override);
}
if (smoke) app.disableHardwareAcceleration();

let window: BrowserWindow | null = null;
let controller: PodController | undefined;
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

function keyVault(userData: string) {
  const directory = join(userData, 'vault');
  const path = join(directory, 'notes-key.bin');
  const requireProtection = () => {
    if (!safeStorage.isEncryptionAvailable()
      || (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) {
      throw new Error('Your computer’s protected key storage is unavailable. Your pod has not been changed.');
    }
  };
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

async function bootstrap(): Promise<void> {
  trace('waiting for Electron');
  await app.whenReady();
  trace('Electron ready');
  Menu.setApplicationMenu(null);
  const userData = app.getPath('userData');
  await mkdir(userData, { recursive: true, mode: 0o700 });
  const options = { dataDir: join(userData, 'local-pod'), vault: keyVault(userData) };
  controller = new PodController(options);
  const pod = controller;
  handle('status', async () => pod.getStatus());
  handle('setup', async () => pod.setup());
  handle('start', async () => pod.start());
  handle('stop', async () => pod.stop());
  handle('notes', async () => pod.listNotes());
  handle('saveNote', async value => pod.saveNote(value as NoteInput));
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
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_details, callback) => callback({ cancel: true }));
  await window.loadFile(entry);
  trace('window loaded');
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
      // Exercise the shipping sandboxed preload and trusted renderer IPC, too.
      const initial = await window.webContents.executeJavaScript('window.interego.status()') as PodStatus;
      if (!initial.localOnly || initial.federationEnabled) throw new Error('The packaged renderer bridge has an invalid local profile.');
      await window.webContents.executeJavaScript(initial.configured ? 'window.interego.start()' : 'window.interego.setup()');
      const note = await window.webContents.executeJavaScript('window.interego.saveNote({title:"Packaged local pod verification",body:"This private note survives a packaged runtime restart."})') as LocalNote;
      await window.webContents.executeJavaScript('window.interego.stop()');
      const reopened = new PodController(options);
      controller = reopened;
      await reopened.start();
      const notes = await reopened.listNotes();
      const status = await reopened.getStatus();
      if (!notes.some(item => item.id === note.id && item.body === note.body) || status.federationEnabled || outbound) {
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

if (!app.requestSingleInstanceLock()) { trace('another instance owns this space'); app.quit(); }
else {
  app.on('second-instance', () => { window?.restore(); window?.show(); window?.focus(); });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (closing) return;
    event.preventDefault(); closing = true;
    void (async () => {
      await Promise.allSettled([...pending]);
      try { await controller?.stop(); app.exit(0); }
      catch { app.exit(1); }
    })();
  });
  void bootstrap().catch(error => {
    if (smoke) { process.stderr.write(`INTEREGO_POD_SMOKE_FAILED: ${errorMessage(error)}\n`); app.exit(1); }
    else void dialog.showMessageBox({ type: 'error', title: 'Interego could not open', message: errorMessage(error) }).then(() => app.quit());
  });
}
