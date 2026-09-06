/** Browser-only adapter. Bundled into the generic HMD viewer; never run by the relay. */
import { ClientKeyVault, type ClientKeyRecord, type ClientKeyRecovery, type ClientKeyStorage } from '../../../packages/core/src/crypto/client-vault.js';
import { canonicalGraphDigest } from '../../../packages/core/src/rdf/graph-digest.js';
import { graphRegion } from '../../../packages/core/src/rdf/turtle-region.js';
import { parseTrig } from '../../../packages/core/src/rdf/turtle-parser.js';
import { turtleIriRef, escapeTurtleLiteral } from '../../../packages/core/src/rdf/escape.js';
import { readEncryptedGraph, unpackToolResult as unpack, type CallTool } from './tool-client.js';

interface Context { actor: string; relay: string }

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('interego-client-encryption-v1', 1);
    request.onupgradeneeded = () => { request.result.createObjectStore('keys'); request.result.createObjectStore('notes'); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('Browser key storage is unavailable. Nothing was sent.'));
    request.onblocked = () => reject(new Error('Close other Interego tabs so browser key storage can open.'));
  });
}

async function transaction<T>(store: string, mode: IDBTransactionMode, run: (store: IDBObjectStore, done: (value: T) => void) => void): Promise<T> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    let result: T;
    tx.oncomplete = () => { db.close(); resolve(result); };
    tx.onabort = tx.onerror = () => { db.close(); reject(new Error('Browser storage failed. The key was not replaced.')); };
    try { run(tx.objectStore(store), value => { result = value; }); }
    catch (error) { tx.abort(); reject(error); }
  });
}

const storage: ClientKeyStorage = {
  load: scope => transaction('keys', 'readonly', (store, done) => {
    const request = store.get(scope); request.onsuccess = () => done(request.result ?? null);
  }),
  create: (scope, record) => transaction('keys', 'readwrite', (store, done) => {
    const request = store.get(scope);
    request.onsuccess = () => {
      if (request.result) { done(request.result as ClientKeyRecord); return; }
      store.add(record, scope).onsuccess = () => done(record);
    };
  }),
};

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); node.textContent = text; return node;
}

export function mount(container: HTMLElement, getContext: () => { clientEncryption?: Context; descriptorUrl?: string }, callTool: CallTool): { reset(): void } {
  const details = element('details'); details.className = 'control';
  details.append(element('summary', 'Client encryption'));
  details.append(element('p', 'Private content is encrypted here before Interego receives it. Your browser holds the key; the existing ChatGPT connection carries only ciphertext.'));
  const status = element('p'); status.className = 'status muted'; status.setAttribute('role', 'status');
  const keyLine = element('p'); keyLine.style.overflowWrap = 'anywhere';
  const enable = element('button', 'Enable on this browser'); enable.className = 'go';
  const note = element('textarea'); note.setAttribute('aria-label', 'Private note'); note.placeholder = 'Write a private note about this resource'; note.rows = 4;
  const recipients = element('input'); recipients.setAttribute('aria-label', 'Recipient public keys'); recipients.placeholder = 'Optional: recipient X25519 public keys, separated by commas';
  const save = element('button', 'Encrypt & save to Interego'); save.className = 'go';
  const descriptor = element('input'); descriptor.setAttribute('aria-label', 'Encrypted descriptor URL'); descriptor.placeholder = 'Saved descriptor URL';
  const open = element('button', 'Read & decrypt here'); open.className = 'go secondary';
  const output = element('pre'); output.className = 'src'; output.hidden = true;
  const recovery = element('details'); recovery.append(element('summary', 'Encrypted recovery'));
  recovery.append(element('p', 'Save a recovery file before storing important content. Losing this browser’s data and your recovery file loses access. The passphrase and unencrypted key never enter a tool call.'));
  const passphrase = element('input'); passphrase.type = 'password'; passphrase.autocomplete = 'new-password'; passphrase.setAttribute('aria-label', 'Recovery passphrase'); passphrase.placeholder = 'Recovery passphrase (12+ characters)';
  const backup = element('button', 'Export encrypted recovery'); backup.className = 'go secondary';
  const restoreText = element('textarea'); restoreText.setAttribute('aria-label', 'Encrypted recovery file'); restoreText.placeholder = 'Paste the encrypted recovery JSON to restore';
  const restore = element('button', 'Restore encrypted recovery'); restore.className = 'go secondary';
  recovery.append(passphrase, backup, restoreText, restore);
  const controls = [enable, save, open, backup, restore];
  const field = (node: HTMLElement) => { const wrapper = element('div'); wrapper.className = 'field'; wrapper.append(node); return wrapper; };
  details.append(enable, keyLine, field(note), field(recipients), save,
    element('p', 'The note stays private. Its existence, author and link to this resource remain visible. Share only with public keys you have verified with their owners.'),
    field(descriptor), open, status, output, recovery);
  container.append(details);
  let activeScope = '';
  let vault: ClientKeyVault;
  let busy = false;

  function context(): Context & { descriptorUrl?: string; scope: string } {
    const current = getContext(), c = current?.clientEncryption;
    if (!c?.actor || !c.relay) throw new Error('Refresh the Interego viewer to load its authenticated client context.');
    const relay = new URL(c.relay);
    if (relay.protocol !== 'https:') throw new Error('A secure Interego relay is required.');
    const scope = `${relay.origin}|${c.actor}`;
    return { ...c, relay: relay.origin, descriptorUrl: current.descriptorUrl, scope };
  }

  async function ready(): Promise<ReturnType<typeof context>> {
    const c = context();
    if (activeScope !== c.scope) {
      activeScope = c.scope;
      vault = new ClientKeyVault(c.scope, storage);
      output.textContent = ''; output.hidden = true;
      descriptor.value = await transaction<string>('notes', 'readonly', (store, done) => {
        const request = store.get(c.scope); request.onsuccess = () => done(request.result ?? '');
      });
    }
    const publicKey = await vault.publicKey();
    keyLine.textContent = publicKey ? `This browser’s public key: ${publicKey}` : 'No client key exists here yet.';
    enable.hidden = !!publicKey;
    return c;
  }

  function sameIdentity(c: ReturnType<typeof context>): void {
    if (context().scope !== c.scope || activeScope !== c.scope) throw new Error('The connected identity changed. Reopen client encryption before continuing.');
  }

  async function read(c: ReturnType<typeof context>, url: string, expected?: { graphIri: string; digest: string; envelope: string }): Promise<void> {
    if (!/^https?:\/\//.test(url)) throw new Error('Enter an encrypted descriptor URL.');
    const result = await readEncryptedGraph(callTool, c.relay, url, () => sameIdentity(c));
    if (result.encrypted !== true || typeof result.envelope !== 'string') throw new Error('This resource is not an encrypted envelope.');
    if (expected && result.envelope !== expected.envelope) throw new Error('Stored ciphertext differs from the ciphertext this browser sent.');
    sameIdentity(c);
    const plaintext = await vault.open(JSON.parse(result.envelope));
    sameIdentity(c);
    if (expected) {
      const region = graphRegion(plaintext, expected.graphIri);
      if (region === null || canonicalGraphDigest(region) !== expected.digest) throw new Error('The decrypted graph does not match this browser’s publication digest.');
    }
    // Render only as text, never as HMD controls or HTML, and never post to the host.
    let display = plaintext;
    try {
      const parsed = parseTrig(plaintext);
      const body = parsed.subjects.flatMap(subject => subject.properties.get('https://schema.org/text') ?? []).find(term => term.kind === 'literal');
      if (body?.kind === 'literal') display = body.value;
    } catch { /* arbitrary encrypted data is still safe to show as text */ }
    output.textContent = display; output.hidden = false;
    status.textContent = expected
      ? 'Saved on Interego. Ciphertext returned unchanged; decryption and the content digest were verified in this browser.'
      : 'Decrypted and authenticated in this browser. No plaintext was returned to the chat or relay.';
    status.className = 'status ok';
  }

  function action(button: HTMLButtonElement, run: () => Promise<void>): void {
    button.addEventListener('click', () => {
      if (busy) return;
      busy = true; controls.forEach(control => { control.disabled = true; });
      status.className = 'status muted'; status.textContent = 'Working…';
      Promise.resolve().then(run).catch(error => {
        status.className = 'status err'; status.textContent = error instanceof Error ? error.message : 'The operation failed.';
      }).finally(() => { busy = false; controls.forEach(control => { control.disabled = false; }); });
    });
  }

  details.addEventListener('toggle', () => { if (details.open && !busy) ready().catch(error => { status.textContent = String(error.message); }); });
  action(enable, async () => { await ready(); await vault.create(); await ready(); status.textContent = 'Key created in this browser. Export encrypted recovery before storing important content.'; });
  action(save, async () => {
    const c = await ready();
    if (!note.value.trim()) throw new Error('Write a private note first.');
    const resourceRef = turtleIriRef(c.descriptorUrl);
    if (!resourceRef) throw new Error('This viewer has no usable resource reference.');
    const graphIri = `urn:uuid:${crypto.randomUUID()}`;
    const graphRef = turtleIriRef(graphIri);
    if (!graphRef) throw new Error('The private graph identifier could not be created.');
    const mirror = `@prefix prov: <http://www.w3.org/ns/prov#> .\n${graphRef} prov:wasDerivedFrom ${resourceRef} .`;
    const turtle = `${graphRef} <https://schema.org/text> "${escapeTurtleLiteral(note.value)}" .\n${graphRef} <http://www.w3.org/ns/prov#wasDerivedFrom> ${resourceRef} .`;
    const digest = canonicalGraphDigest(turtle);
    if (!digest) throw new Error('The private note could not be represented as a graph.');
    const recipientKeys = recipients.value.split(',').map(key => key.trim()).filter(Boolean);
    const envelope = JSON.stringify(await vault.seal(`${graphRef} {\n${turtle}\n}`, recipientKeys));
    sameIdentity(c);
    const published = unpack(await callTool('publish_context', {
      graph_iri: graphIri, graph_content: envelope, sealed_payload: true, content_digest: digest,
      cleartext_mirror: mirror, visibility: recipientKeys.length ? 'shared' : 'private',
      sign_authorship: true, auto_supersede_prior: false,
    }));
    sameIdentity(c);
    if (published.status !== 'committed') throw new Error('The write is not confirmed committed. Check your pod before retrying.');
    if (typeof published.descriptorUrl !== 'string') throw new Error('Interego returned no descriptor URL. Check your pod before retrying the write.');
    descriptor.value = published.descriptorUrl;
    try {
      await transaction('notes', 'readwrite', (store, done) => { store.put(descriptor.value, c.scope).onsuccess = () => done(undefined); });
      await read(c, descriptor.value, { graphIri, digest, envelope });
    } catch (error) {
      // Keep the committed URL visible. Retrying verification is safe; saving again
      // would create a second note and must never be an automatic recovery action.
      throw new Error(`Saved at ${published.descriptorUrl}, but verification did not complete: ${error instanceof Error ? error.message : 'read failed'}. Use Read & decrypt here to retry the read.`);
    }
    note.value = '';
  });
  action(open, async () => { const c = await ready(); await read(c, descriptor.value.trim()); });
  action(backup, async () => {
    await ready();
    const encrypted = JSON.stringify(await vault.backup(passphrase.value), null, 2);
    passphrase.value = ''; restoreText.value = encrypted;
    const url = URL.createObjectURL(new Blob([encrypted], { type: 'application/json' }));
    const link = element('a'); link.href = url; link.download = 'interego-encrypted-recovery.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    status.textContent = 'Encrypted recovery is ready below and a download was requested. Save it and keep its passphrase separately.';
  });
  action(restore, async () => {
    await ready(); await vault.restore(JSON.parse(restoreText.value) as ClientKeyRecovery, passphrase.value);
    passphrase.value = ''; restoreText.value = ''; await ready(); status.textContent = 'Client key restored in this browser.';
  });
  return { reset() {
    activeScope = ''; note.value = ''; recipients.value = ''; descriptor.value = '';
    passphrase.value = ''; restoreText.value = ''; output.textContent = ''; output.hidden = true;
    keyLine.textContent = ''; details.open = false; status.textContent = 'The connected identity changed.';
  } };
}
