import { signIn } from './oauth.mjs';
import { normalizeRelay, discoverCatalog, callTool } from './relay.mjs';
import { createWallet } from './wallet.mjs';

const wallet = createWallet({ chrome, signIn, normalizeRelay, discoverCatalog, callTool });
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  wallet.dispatch(message, sender).then(value => respond({ ok: true, value }), error => respond({ ok: false, error: error.message }));
  return true;
});

chrome.action.onClicked.addListener(async tab => {
  await wallet.ready;
  let draft = null;
  let captureNotice = '';
  try {
    const page = new URL(tab.url);
    if (page.protocol !== 'https:' && page.protocol !== 'http:') throw new Error('Open a web page and select text to capture it.');
    const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => ({ title: document.title.slice(0, 200), text: String(window.getSelection()).slice(0, 16000) }) });
    // Query and fragment may carry credentials or one-use links; capture source without them.
    page.search = ''; page.hash = ''; page.username = ''; page.password = '';
    draft = { title: result?.result?.title ?? '', text: result?.result?.text ?? '', url: page.href, purpose: '' };
    if (!draft.text) captureNotice = 'No text was selected. Select text on the page and click Interego again, or write a note here.';
  } catch {
    captureNotice = 'This page cannot be captured. You can write a note here or select text on a web page.';
  }
  await chrome.storage.session.set({ ...(draft ? { draft } : {}), captureNotice });
  await chrome.tabs.create({ url: chrome.runtime.getURL('app.html') });
});
