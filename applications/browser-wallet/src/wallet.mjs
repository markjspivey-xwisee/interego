import { buildCapture } from './relay.mjs';

const MAX_RECEIPTS = 50;
const REVIEW_TTL = 5 * 60 * 1000;
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const str = (value, max, name) => {
  if (typeof value !== 'string' || value.length > max) throw new Error(`Invalid ${name}.`);
  return value;
};

export function trustedSender(sender, runtime) {
  return sender?.id === runtime.id && sender?.url === runtime.getURL('app.html');
}

export function profileFromStatus(status, relay) {
  const principal = status?.sessionAgent?.did ?? status?.sessionAgent?.id;
  const podUrl = status?.pod;
  if (typeof principal !== 'string' || !principal || typeof podUrl !== 'string' || !podUrl) {
    throw new Error('The relay did not identify the current session agent and pod.');
  }
  return { id: `${relay}|${principal}`, relay, principal, podUrl };
}

export function createWallet({ chrome, signIn, discoverCatalog, callTool, normalizeRelay, now = Date.now, uuid = () => crypto.randomUUID() }) {
  let queue = Promise.resolve();
  const ready = Promise.all([
    chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
    chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
  ]);
  const serial = fn => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => {});
    return next;
  };
  async function load() {
    await ready;
    const local = await chrome.storage.local.get({ accounts: [], receipts: [], activeId: null });
    const session = await chrome.storage.session.get({ sessions: {}, draft: null, review: null, captureNotice: '' });
    return { ...local, ...session };
  }
  async function current(s) {
    const account = s.accounts.find(a => a.id === s.activeId);
    const session = s.sessions[s.activeId];
    if (!account || !session || session.expiresAt <= now()) throw new Error('Sign in to continue. This browser session has no active connection.');
    if (!await chrome.permissions.contains({ origins: [`${account.relay}/*`] })) throw new Error('Browser access to this relay was removed. Connect again to continue.');
    return { account, session };
  }
  function safeState(s) {
    return {
      accounts: s.accounts.map(a => ({ ...a, connected: Boolean(s.sessions[a.id]?.expiresAt > now()), scope: s.sessions[a.id]?.scope ?? '' })),
      activeId: s.activeId, draft: s.draft, receipts: s.receipts, captureNotice: s.captureNotice,
      review: s.review && s.review.expiresAt > now() ? s.review : null,
    };
  }
  async function tool(account, session, name, args) {
    return callTool(account.relay, session.accessToken, session.catalog, name, args);
  }
  async function receipt(s, entry) {
    s.receipts.unshift(entry);
    s.receipts = s.receipts.slice(0, MAX_RECEIPTS);
    await chrome.storage.local.set({ receipts: s.receipts });
  }
  async function handle(m, sender) {
    if (!trustedSender(sender, chrome.runtime)) throw new Error('Only the Interego Wallet page can request this operation.');
    if (!record(m) || typeof m.type !== 'string') throw new Error('Invalid request.');
    const s = await load();
    if (['REFRESH', 'DESCRIPTOR', 'PREPARE', 'SAVE', 'DISCONNECT'].includes(m.type) && m.expectedAccountId !== s.activeId) {
      throw new Error('The active identity changed in another window. Reload the wallet and review this identity before continuing.');
    }
    switch (m.type) {
      case 'STATE': return safeState(s);
      case 'CONNECT': {
        const relay = normalizeRelay(str(m.relay, 2048, 'relay'));
        const scope = m.scope ?? 'mcp:read';
        if (!['mcp:read', 'mcp:write'].includes(scope)) throw new Error('Invalid connection scope.');
        if (!await chrome.permissions.contains({ origins: [`${relay}/*`] })) throw new Error('Allow access to this relay before connecting.');
        const auth = await signIn({ relay, scope, redirectUri: chrome.identity.getRedirectURL('interego'), launch: url => chrome.identity.launchWebAuthFlow({ url, interactive: true }) });
        const catalog = await discoverCatalog(relay, {});
        const session = { ...auth, catalog };
        const status = await callTool(relay, auth.accessToken, catalog, 'get_pod_status', {});
        const account = profileFromStatus(status, relay);
        s.accounts = [...s.accounts.filter(a => a.id !== account.id), account];
        s.sessions[account.id] = session;
        await chrome.storage.local.set({ accounts: s.accounts, activeId: account.id });
        await chrome.storage.session.set({ sessions: s.sessions, review: null });
        return safeState({ ...s, activeId: account.id, review: null });
      }
      case 'SWITCH': {
        const id = str(m.accountId, 4096, 'account');
        if (!s.accounts.some(a => a.id === id)) throw new Error('Unknown account.');
        await chrome.storage.local.set({ activeId: id });
        await chrome.storage.session.set({ review: null });
        return safeState({ ...s, activeId: id, review: null });
      }
      case 'REFRESH': {
        const { account, session } = await current(s);
        const status = await tool(account, session, 'get_pod_status', {});
        const live = profileFromStatus(status, account.relay);
        if (live.id !== account.id || live.podUrl !== account.podUrl) throw new Error('The authenticated identity changed. Connect again before continuing.');
        const result = await tool(account, session, 'discover_context', { pod_url: account.podUrl, limit: 12, sort: 'newest-first' });
        if (!Array.isArray(result.entries) || result.pod !== account.podUrl) throw new Error('The pod could not be read, or the relay answered for a different pod.');
        // Retain only references that this authenticated discovery actually returned.
        session.descriptors = result.entries.map(e => e?.descriptorUrl).filter(u => typeof u === 'string');
        await chrome.storage.session.set({ sessions: s.sessions });
        return { account, entries: result.entries };
      }
      case 'DESCRIPTOR': {
        const { account, session } = await current(s);
        const url = str(m.url, 4096, 'descriptor');
        if (!session.descriptors?.includes(url)) throw new Error('Choose a descriptor from the current context list.');
        const result = await tool(account, session, 'get_descriptor', { url });
        // Never return rendered HTML or execute HyperMarkdown from a remote result.
        return { url, turtle: result.turtle ?? '', graph: result.graph ?? null, authorship: result.authorship ?? null };
      }
      case 'PREPARE': {
        const { account, session } = await current(s);
        if (!session.scope.split(' ').some(x => x === 'mcp' || x === 'mcp:write')) throw new Error('Connect with permission to save before preparing a note.');
        const payload = buildCapture({ title: str(m.title, 200, 'title'), url: str(m.url, 4096, 'source URL'), text: str(m.text, 16000, 'selected text'), purpose: str(m.purpose, 500, 'purpose') });
        const review = { id: uuid(), accountId: account.id, title: payload.title, body: payload.body, visibility: 'private', destination: account.podUrl, relay: account.relay, principal: account.principal, expiresAt: now() + REVIEW_TTL };
        await chrome.storage.session.set({ review });
        return review;
      }
      case 'CANCEL': {
        await chrome.storage.session.set({ review: null });
        return { cancelled: true };
      }
      case 'SAVE': {
        const { account, session } = await current(s);
        const review = s.review;
        if (!review || m.reviewId !== review.id || review.accountId !== account.id || review.expiresAt <= now()) throw new Error('This review expired or the account changed. Review the note again.');
        if (!session.scope.split(' ').some(x => x === 'mcp' || x === 'mcp:write')) throw new Error('This connection cannot save notes.');
        // Consume before the non-idempotent write. A double click or uncertain response cannot replay it.
        await chrome.storage.session.set({ review: null });
        const entry = { id: uuid(), at: new Date(now()).toISOString(), accountId: account.id, relay: account.relay, principal: account.principal, title: review.title, visibility: 'private', status: 'uncertain', descriptorUrl: null };
        await receipt(s, entry);
        try {
          const status = profileFromStatus(await tool(account, session, 'get_pod_status', {}), account.relay);
          if (status.id !== account.id || status.podUrl !== review.destination) {
            entry.status = 'refused';
            throw new Error('The authenticated identity changed. No note was sent.');
          }
          const saved = await tool(account, session, 'remember', { title: review.title, body: review.body, visibility: 'private' });
          if (saved.remembered !== true || saved.visibility !== 'private' || typeof saved.descriptorUrl !== 'string') throw new Error('The relay did not confirm a private save. Check the pod before trying again.');
          entry.descriptorUrl = saved.descriptorUrl;
          entry.status = 'accepted';
          try {
            const read = await tool(account, session, 'get_descriptor', { url: saved.descriptorUrl });
            if (read.url === saved.descriptorUrl && typeof read.graph?.content === 'string' && read.graph.content.length > 0) entry.status = 'read-back';
          } catch { /* Accepted and unreadable is reported separately; never repeat remember. */ }
          await chrome.storage.session.set({ draft: null });
        } catch (error) {
          entry.detail = entry.status === 'refused' ? 'Identity check refused this save.' : 'The result is uncertain. Inspect the pod before creating another note.';
          await chrome.storage.local.set({ receipts: s.receipts });
          throw new Error(entry.detail);
        }
        await chrome.storage.local.set({ receipts: s.receipts });
        return entry;
      }
      case 'DISCONNECT': {
        const account = s.accounts.find(a => a.id === s.activeId);
        delete s.sessions[s.activeId];
        s.accounts = s.accounts.filter(a => a.id !== s.activeId);
        const activeId = s.accounts[0]?.id ?? null;
        // Forget local identity/receipts. Remote notes and server grants are managed at the relay.
        s.receipts = s.receipts.filter(r => r.accountId !== s.activeId);
        await chrome.storage.local.set({ accounts: s.accounts, activeId, receipts: s.receipts });
        await chrome.storage.session.set({ sessions: s.sessions, review: null });
        if (account && !s.accounts.some(a => a.relay === account.relay)) await chrome.permissions.remove({ origins: [`${account.relay}/*`] });
        return safeState({ ...s, activeId, review: null });
      }
      default: throw new Error('Unknown wallet operation.');
    }
  }
  return { dispatch: (message, sender) => serial(() => handle(message, sender)), ready };
}
