/** Shipping Identity HTML and bundled UI; only the native IPC boundary is substituted. No browser or GPU. */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import type { DesktopApi, PodStatus } from '../src/types.js';
import type { LocalIdentityApproval, LocalIdentityLinkApproval, LocalIdentitySignInApproval, LocalIdentityStatus } from '../src/local-identity-types.js';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..'); let bundle = '';
const documents: JSDOM[] = [];
beforeAll(async () => {
  const result = await build({ entryPoints: [join(APP, 'src/identity-renderer.ts')], bundle: true, format: 'iife', globalName: 'IdentityUi', platform: 'browser', target: 'es2022', write: false, logLevel: 'silent' });
  bundle = result.outputFiles[0]!.text;
});
afterEach(() => { for (const dom of documents.splice(0)) dom.window.close(); });
const off = (): LocalIdentityStatus => ({ configured: false, pending: [] });
const ready = (pending: readonly LocalIdentityApproval[] = []): LocalIdentityStatus => ({ configured: true,
  identity: { did: 'did:key:z6MkPublicIdentity', fingerprint: 'FINGERPRINT-THIS-PC', createdAt: '2026-10-30T12:00:00Z' }, pending });
const request = (patch: Partial<LocalIdentitySignInApproval> = {}): LocalIdentitySignInApproval => ({ id: 'request-one', state: 'waiting', clientId: 'https://game.example/identity/client.json', clientName: 'My game',
  relayOrigin: 'https://relay.example', identityOrigin: 'https://identity.example', redirectOrigin: 'https://game.example', redirectUri: 'https://game.example/identity/callback?flow=game',
  scopes: ['mcp:read'], resource: 'https://relay.example/mcp', verificationCode: 'ABCD 1234', expiresAt: new Date(Date.now() + 120_000).toISOString(), ...patch });
const link = (patch: Partial<LocalIdentityLinkApproval> = {}): LocalIdentityLinkApproval => ({ purpose: 'link', id: 'link-one', state: 'waiting', identityOrigin: 'https://identity.example',
  owner: { userId: 'existing-account', did: 'did:pkh:eip155:1:existing-owner', webId: 'https://hosted.example/existing/profile/card#me', podUrl: 'https://hosted.example/existing/', displayName: 'Existing player' },
  credentialDid: 'did:key:z6MkPublicIdentity', credentialFingerprint: 'FINGERPRINT-THIS-PC', verificationCode: 'CDAB 4321', expiresAt: new Date(Date.now() + 120_000).toISOString(), ...patch });
const pod: PodStatus = { state: 'stopped', configured: true, running: false, localOnly: true, federationEnabled: false, noteCount: 0 };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function flush(): Promise<void> { for (let i = 0; i < 3; i++) await new Promise<void>(done => setImmediate(done)); }
async function mount(initial = off(), overrides: Partial<DesktopApi> = {}, attention: () => boolean = () => true) {
  let current = initial; let ids: readonly string[] = [];
  const showIdentity = vi.fn(attention);
  const api = {
    localIdentityStatus: vi.fn(async () => current),
    setupLocalIdentity: vi.fn(async () => { current = ready(); return current; }),
    approveLocalIdentity: vi.fn(async (id: string, _code: string) => { current = { ...current, pending: current.pending.filter(item => item.id !== id) }; return current; }),
    denyLocalIdentity: vi.fn(async (id: string) => { current = { ...current, pending: current.pending.filter(item => item.id !== id) }; return current; }),
    forgetLocalIdentity: vi.fn(async () => { current = off(); return current; }),
    identityExtensionIds: vi.fn(async () => ids),
    setIdentityExtensionIds: vi.fn(async (next: readonly string[]) => { ids = next; return ids; }),
    backupLocalIdentity: vi.fn(async (_passphrase: string) => ({ cancelled: false, status: current })),
    restoreLocalIdentity: vi.fn(async (_passphrase: string) => { current = ready(); return { cancelled: false, status: current }; }),
    openHosted: vi.fn(async () => {}),
    ...overrides,
  };
  const dom = new JSDOM(readFileSync(join(APP, 'index.html'), 'utf8'), { url: 'file:///interego/index.html', runScripts: 'outside-only' }); documents.push(dom);
  Object.defineProperties(dom.window, { interego: { value: api }, identityTestPod: { value: pod, writable: true }, identityTestBusy: { value: false, writable: true }, identityTestShow: { value: showIdentity } });
  dom.window.eval(bundle + `\nwindow.identityTestUi = IdentityUi.installIdentityUi(window.interego, { pod: () => window.identityTestPod, locallyBusy: () => window.identityTestBusy,
    openDialog: dialog => dialog.setAttribute('open', ''), closeDialog: dialog => { dialog.removeAttribute('open'); dialog.dispatchEvent(new Event('close')); }, showIdentity: () => window.identityTestShow() });`);
  const ui = (dom.window as unknown as { identityTestUi: { refresh(): Promise<void>; updateAvailability(): void } }).identityTestUi;
  await ui.refresh();
  const get = <T extends HTMLElement = HTMLElement>(id: string) => dom.window.document.getElementById(id) as T;
  return { dom, api, ui, get, showIdentity, setState: (value: LocalIdentityStatus) => { current = value; },
    click: (id: string) => get<HTMLButtonElement>(id).click(),
    fill: (id: string, value: string) => { get<HTMLInputElement>(id).value = value; get(id).dispatchEvent(new dom.window.Event('input')); },
    check: (id: string, checked = true) => { get<HTMLInputElement>(id).checked = checked; get(id).dispatchEvent(new dom.window.Event('change')); },
    submit: (id: string) => get(id).dispatchEvent(new dom.window.Event('submit', { cancelable: true, bubbles: true })),
    pendingApprove: () => get('identity-pending').querySelector<HTMLButtonElement>('button[data-identity-approve]')!,
    busy: (value: boolean) => { Object.defineProperty(dom.window, 'identityTestBusy', { value }); ui.updateAvailability(); },
  };
}

describe('native Identity page', () => {
  it('batches waiting requests into one reveal and does not repeat while they remain pending', async () => {
    const app = await mount(ready()); const pending = [link(), request()]; app.setState(ready(pending)); await app.ui.refresh();
    expect(app.showIdentity).toHaveBeenCalledOnce(); await app.ui.refresh(); expect(app.showIdentity).toHaveBeenCalledOnce();
    app.setState(ready()); await app.ui.refresh(); app.setState(ready(pending)); await app.ui.refresh(); expect(app.showIdentity).toHaveBeenCalledTimes(2);
    await app.ui.refresh(); expect(app.showIdentity).toHaveBeenCalledTimes(2);
    for (const item of pending) expect(app.get<HTMLInputElement>('identity-verify-' + item.id).checked).toBe(false);
    expect(app.api.approveLocalIdentity).not.toHaveBeenCalled();
  });
  it('retries a deferred reveal once allowed and does not consume attention while another screen is occupied', async () => {
    let allowed = false; const app = await mount(ready(), {}, () => allowed); app.setState(ready([link()])); await app.ui.refresh();
    expect(app.showIdentity).toHaveBeenCalledOnce(); allowed = true; await app.ui.refresh(); expect(app.showIdentity).toHaveBeenCalledTimes(2);
    await app.ui.refresh(); expect(app.showIdentity).toHaveBeenCalledTimes(2); expect(app.api.approveLocalIdentity).not.toHaveBeenCalled();
  });
  it('ignores an older waiting result that arrives after a newer empty status without revealing it', async () => {
    const app = await mount(ready()); const stale = deferred<LocalIdentityStatus>();
    (app.api.localIdentityStatus as ReturnType<typeof vi.fn>).mockImplementationOnce(() => stale.promise);
    const first = app.ui.refresh(); await app.ui.refresh(); stale.resolve(ready([link()])); await first;
    expect(app.showIdentity).not.toHaveBeenCalled(); expect(app.get('identity-pending').children.length).toBe(0); expect(app.api.approveLocalIdentity).not.toHaveBeenCalled();
  });
  it.each([false, true])('does not reveal waiting requests without a current configured public identity (configured=%s)', async configured => {
    const app = await mount({ configured, pending: [request(), link()] });
    expect(app.showIdentity).not.toHaveBeenCalled(); expect(app.pendingApprove().disabled).toBe(true); expect(app.api.approveLocalIdentity).not.toHaveBeenCalled();
  });
  it('creates no credential automatically, makes linking existing accounts the first path, and works while notes are stopped', async () => {
    const app = await mount(); expect(app.api.setupLocalIdentity).not.toHaveBeenCalled();
    expect(app.get<HTMLButtonElement>('create-local-identity').disabled).toBe(true);
    expect(app.get('identity-create-fields').textContent).toContain('does not connect it to your existing account');
    expect(app.get('identity-page').textContent).toContain('Add this PC key'); expect(app.get('identity-page').textContent).toContain('Hallowmarch');
    app.click('open-identity-dashboard'); await flush(); expect(app.api.openHosted).toHaveBeenCalledOnce(); expect(app.api.setupLocalIdentity).not.toHaveBeenCalled();
    app.check('identity-create-consent'); app.click('create-local-identity'); await flush();
    expect(app.api.setupLocalIdentity).toHaveBeenCalledOnce(); expect(app.get('identity-fingerprint').textContent).toBe('FINGERPRINT-THIS-PC');
    expect(app.get('identity-create-fields').hidden).toBe(true); expect(app.get<HTMLButtonElement>('restore-local-identity').disabled).toBe(true);
  });
  it('shows the exact existing account and PC key, and requires explicit link consent without creating or signing into another account', async () => {
    const pending = link({ owner: { ...link().owner, displayName: '<img src=x onerror=steal()>' } }); const app = await mount(ready([pending]));
    const text = app.get('identity-pending').textContent!;
    for (const value of [pending.owner.displayName, pending.owner.userId, pending.owner.did, pending.owner.webId, pending.owner.podUrl, pending.identityOrigin,
      pending.credentialDid, pending.credentialFingerprint, pending.verificationCode, 'adds a sign-in method', 'does not move my character, progress or data']) expect(text).toContain(value);
    expect(app.get('identity-pending').querySelector('img')).toBeNull(); expect(app.pendingApprove().textContent).toBe('Add PC key'); expect(app.pendingApprove().disabled).toBe(true);
    app.pendingApprove().click(); expect(app.api.approveLocalIdentity).not.toHaveBeenCalled();
    app.check('identity-verify-link-one'); expect(app.pendingApprove().disabled).toBe(false); app.pendingApprove().click(); await flush();
    expect(app.api.approveLocalIdentity).toHaveBeenCalledWith(pending.id, pending.verificationCode); expect(app.api.setupLocalIdentity).not.toHaveBeenCalled();
    expect(app.get('identity-message').textContent).toContain('added to your existing account');
  });
  it('resets link consent for any owner, provider, key or code change and blocks a key that differs from this PC', async () => {
    const original = link(); const app = await mount(ready([original]));
    for (const changed of [link({ owner: { ...original.owner, podUrl: 'https://hosted.example/other/' } }),
      link({ owner: { ...original.owner, did: 'did:key:other-owner' } }), link({ identityOrigin: 'https://other-identity.example' }),
      link({ verificationCode: 'EEEE 1111' }), link({ credentialFingerprint: 'OTHER-PC-KEY' })]) {
      app.setState(ready([original])); await app.ui.refresh(); app.check('identity-verify-link-one'); expect(app.pendingApprove().disabled).toBe(false);
      app.setState(ready([changed])); await app.ui.refresh(); expect(app.pendingApprove().disabled).toBe(true); expect(app.get<HTMLInputElement>('identity-verify-link-one').checked).toBe(false);
    }
    app.check('identity-verify-link-one'); expect(app.pendingApprove().disabled).toBe(true); expect(app.get('identity-pending').textContent).toContain('no longer matches the key on this PC');
    expect(app.api.approveLocalIdentity).not.toHaveBeenCalled();
  });
  it('declines enrollment without adding the key and labels an in-progress link separately from sign-in', async () => {
    const pending = link(); const app = await mount(ready([pending]));
    [...app.get('identity-pending').querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Decline')!.click(); await flush();
    expect(app.api.denyLocalIdentity).toHaveBeenCalledWith(pending.id); expect(app.api.approveLocalIdentity).not.toHaveBeenCalled();
    app.setState(ready([link({ state: 'completing' })])); await app.ui.refresh(); expect(app.pendingApprove()).toBeNull(); expect(app.get('identity-pending').textContent).toContain('Adding this PC key');
  });
  it('shows exact server-derived details as text and needs started-request/code-match consent', async () => {
    const pending = request({ clientName: '<img src=x onerror=steal()>' }); const app = await mount(ready([pending]));
    const text = app.get('identity-pending').textContent!;
    for (const value of [pending.clientName, pending.clientId, pending.identityOrigin, pending.relayOrigin, pending.redirectOrigin, pending.redirectUri, 'mcp:read', pending.resource!, pending.verificationCode]) expect(text).toContain(value);
    expect(app.get('identity-pending').querySelector('img')).toBeNull(); expect(app.pendingApprove().disabled).toBe(true);
    app.check('identity-verify-request-one'); expect(app.pendingApprove().disabled).toBe(false);
    await app.ui.refresh(); expect(app.get<HTMLInputElement>('identity-verify-request-one').checked).toBe(true);
    app.pendingApprove().click(); await flush(); expect(app.api.approveLocalIdentity).toHaveBeenCalledWith(pending.id, pending.verificationCode);
    expect(app.get('identity-pending').children.length).toBe(0);
  });
  it('changed request metadata invalidates earlier consent and an expired or completing request cannot be approved', async () => {
    const pending = request(); const app = await mount(ready([pending])); app.check('identity-verify-request-one');
    app.setState(ready([{ ...pending, scopes: ['mcp:write'] }])); await app.ui.refresh(); expect(app.pendingApprove().disabled).toBe(true);
    expect(app.get<HTMLInputElement>('identity-verify-request-one').checked).toBe(false);
    app.check('identity-verify-request-one'); app.setState({ ...ready([pending]), identity: { ...ready().identity!, fingerprint: 'CHANGED-PC-KEY' } }); await app.ui.refresh();
    expect(app.get<HTMLInputElement>('identity-verify-request-one').checked).toBe(false); expect(app.pendingApprove().disabled).toBe(true);
    app.setState(ready([{ ...pending, expiresAt: new Date(Date.now() - 1).toISOString() }])); await app.ui.refresh(); app.check('identity-verify-request-one'); expect(app.pendingApprove().disabled).toBe(true);
    app.setState(ready([{ ...pending, state: 'completing' }])); await app.ui.refresh(); expect(app.pendingApprove()).toBeNull(); expect(app.get('identity-pending').textContent).toContain('Finishing sign-in');
    expect(app.api.approveLocalIdentity).not.toHaveBeenCalled();
  });
  it('declines without approval and stale polls cannot resurrect the denied request', async () => {
    const pending = request(); const app = await mount(ready([pending])); const stale = deferred<LocalIdentityStatus>();
    const checkStatus = app.api.localIdentityStatus as ReturnType<typeof vi.fn>; checkStatus.mockImplementationOnce(() => stale.promise);
    const read = app.ui.refresh();
    [...app.get('identity-pending').querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Decline')!.click(); await flush();
    stale.resolve(ready([pending])); await read;
    expect(app.api.denyLocalIdentity).toHaveBeenCalledWith(pending.id); expect(app.api.approveLocalIdentity).not.toHaveBeenCalled(); expect(app.get('identity-pending').children.length).toBe(0);
  });
  it('saves at most four explicit sign-in extension IDs and keeps an edited draft through polls', async () => {
    const app = await mount(ready()); const id = 'a'.repeat(32); app.fill('identity-extension-ids', id); await app.ui.refresh(); expect(app.get<HTMLTextAreaElement>('identity-extension-ids').value).toBe(id);
    app.submit('identity-extensions-form'); await flush(); expect(app.api.setIdentityExtensionIds).not.toHaveBeenCalled();
    app.check('identity-extension-consent'); app.submit('identity-extensions-form'); await flush(); expect(app.api.setIdentityExtensionIds).toHaveBeenCalledWith([id]);
    app.fill('identity-extension-ids', ['a', 'b', 'c', 'd', 'e'].map(char => char.repeat(32)).join('\n')); app.check('identity-extension-consent'); app.submit('identity-extensions-form'); await flush(); expect(app.api.setIdentityExtensionIds).toHaveBeenCalledTimes(1);
    app.fill('identity-extension-ids', 'not-an-extension'); app.check('identity-extension-consent'); app.submit('identity-extensions-form'); expect(app.get('identity-message').textContent).toContain('32 lowercase');
    app.fill('identity-extension-ids', ''); app.check('identity-extension-consent'); app.submit('identity-extensions-form'); await flush(); expect(app.api.setIdentityExtensionIds).toHaveBeenLastCalledWith([]);
  });
  it('backup requires matching passphrases and clears secrets before the native file chooser resolves', async () => {
    const waiting = deferred<{ cancelled: boolean; status: LocalIdentityStatus }>(); const backup = vi.fn(() => waiting.promise); const app = await mount(ready(), { backupLocalIdentity: backup });
    app.click('backup-local-identity'); expect(app.get<HTMLDialogElement>('identity-backup-dialog').open).toBe(true);
    app.fill('identity-passphrase', 'a safe recovery passphrase'); app.fill('identity-passphrase-confirmation', 'different'); app.submit('identity-backup-form'); await flush(); expect(backup).not.toHaveBeenCalled();
    app.fill('identity-passphrase-confirmation', 'a safe recovery passphrase'); app.submit('identity-backup-form');
    expect(backup).toHaveBeenCalledWith('a safe recovery passphrase'); expect(app.get<HTMLInputElement>('identity-passphrase').value).toBe(''); expect(app.get<HTMLInputElement>('identity-passphrase-confirmation').value).toBe('');
    expect(app.get<HTMLButtonElement>('cancel-identity-backup').disabled).toBe(true);
    waiting.resolve({ cancelled: false, status: ready() }); await flush(); expect(app.get<HTMLDialogElement>('identity-backup-dialog').open).toBe(false); expect(app.get('identity-message').textContent).toContain('backup is saved');
  });
  it('restore uses the original identity and clears passphrases on error, cancellation and close', async () => {
    const restore = vi.fn(async () => { throw new Error('wrong passphrase'); }); const app = await mount(off(), { restoreLocalIdentity: restore });
    app.click('restore-local-identity'); expect(app.get('identity-passphrase-confirmation-field').hidden).toBe(true);
    app.fill('identity-passphrase', 'recover the same identity'); app.submit('identity-backup-form'); await flush(); expect(restore).toHaveBeenCalledWith('recover the same identity');
    expect(app.get<HTMLInputElement>('identity-passphrase').value).toBe(''); expect(app.get('identity-backup-message').textContent).toContain('could not be restored');
    app.fill('identity-passphrase', 'do not retain this phrase'); app.click('cancel-identity-backup'); expect(app.get<HTMLInputElement>('identity-passphrase').value).toBe('');
    app.api.restoreLocalIdentity = vi.fn(async () => ({ cancelled: false, status: ready() }));
    app.click('restore-local-identity'); app.fill('identity-passphrase', 'recover the same identity'); app.submit('identity-backup-form'); await flush(); expect(app.get('identity-fingerprint').textContent).toBe('FINGERPRINT-THIS-PC');
  });
  it('file chooser cancellation keeps no passphrase and forgetting needs a separate recovery acknowledgment', async () => {
    const app = await mount(ready(), { backupLocalIdentity: vi.fn(async () => ({ cancelled: true, status: ready() })) });
    app.click('backup-local-identity'); app.fill('identity-passphrase', 'a long backup phrase'); app.fill('identity-passphrase-confirmation', 'a long backup phrase'); app.submit('identity-backup-form'); await flush();
    expect(app.get<HTMLInputElement>('identity-passphrase').value).toBe(''); expect(app.get('identity-backup-message').textContent).toContain('No file was selected'); app.click('cancel-identity-backup');
    app.click('forget-local-identity'); app.click('confirm-forget-local-identity'); expect(app.api.forgetLocalIdentity).not.toHaveBeenCalled();
    expect(app.get('identity-forget-review').textContent).toContain('may lose account access'); app.check('identity-forget-consent'); app.click('confirm-forget-local-identity'); await flush();
    expect(app.api.forgetLocalIdentity).toHaveBeenCalledOnce(); expect(app.get('identity-key-details').hidden).toBe(true); expect(app.get('identity-forget-review').hidden).toBe(true);
  });
  it('failed key status leaves only recovery backup and explicit forget usable', async () => {
    const app = await mount(off(), { localIdentityStatus: vi.fn(async () => { throw new Error('corrupt protected key'); }) });
    expect(app.get('identity-recovery-warning').hidden).toBe(false); expect(app.get<HTMLButtonElement>('create-local-identity').disabled).toBe(true);
    expect(app.get<HTMLButtonElement>('backup-local-identity').disabled).toBe(false); expect(app.get<HTMLButtonElement>('forget-local-identity').disabled).toBe(false); expect(app.get<HTMLButtonElement>('restore-local-identity').disabled).toBe(true);
    app.click('forget-local-identity'); app.check('identity-forget-consent'); app.click('confirm-forget-local-identity'); await flush(); expect(app.api.forgetLocalIdentity).toHaveBeenCalledOnce();
  });
  it('a successful recovery export without public identity still permits acknowledged key removal', async () => {
    const fallback: LocalIdentityStatus = { configured: true, pending: [] };
    const app = await mount(ready(), { backupLocalIdentity: vi.fn(async () => ({ cancelled: false, status: fallback })) });
    app.click('backup-local-identity'); app.fill('identity-passphrase', 'keep my identity safe'); app.fill('identity-passphrase-confirmation', 'keep my identity safe'); app.submit('identity-backup-form'); await flush();
    expect(app.get('identity-recovery-warning').hidden).toBe(false); expect(app.get('identity-key-details').hidden).toBe(true);
    app.click('forget-local-identity'); expect(app.get('identity-forget-review').hidden).toBe(false); expect(app.get<HTMLButtonElement>('confirm-forget-local-identity').disabled).toBe(true);
    app.check('identity-forget-consent'); app.click('confirm-forget-local-identity'); await flush(); expect(app.api.forgetLocalIdentity).toHaveBeenCalledOnce();
  });
  it('unavailable IPC and local operations disable identity changes without breaking the page', async () => {
    const absent = await mount(off(), { localIdentityStatus: undefined }); expect(absent.get('identity-status').textContent).toContain('unavailable in this version'); expect(absent.get<HTMLButtonElement>('create-local-identity').disabled).toBe(true);
    const app = await mount(ready([request()])); app.check('identity-verify-request-one'); app.busy(true); expect(app.pendingApprove().disabled).toBe(true); expect(app.get<HTMLButtonElement>('backup-local-identity').disabled).toBe(true);
    app.busy(false); expect(app.pendingApprove().disabled).toBe(false);
  });
});
