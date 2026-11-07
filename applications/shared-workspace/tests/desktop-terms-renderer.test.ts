/**
 * THE DESKTOP SIGN-IN SCREEN'S HOSTED TERMS AGREEMENT, DRIVEN AS THE REAL RENDERER IN A REAL DOM.
 *
 * ★ WHAT THIS FILE EXISTS TO CATCH. A wallet key that opens a NEW hosted account is refused by the
 * identity server (HTTP 428) unless its sign-in carries the current Hosted Interego Terms version.
 * The window therefore has to show the terms and an "I agree" box — and the version may cross to
 * the main process ONLY from a box the person ticked: not by default, not from the other box on
 * the page, not from a version the server has since replaced.
 *
 * ★ WHAT IS REAL AND WHAT IS SCRIPTED. REAL: `desktop/src/renderer.ts`, bundled by esbuild as
 * `npm run build` bundles it, run in jsdom against the shipping `desktop/index.html`. SCRIPTED:
 * `window.interego`, which in the app is the IPC bridge to the main process — here it records the
 * arguments each sign-in crossed with, which is exactly the fact under test. What the main process
 * then does with the version is covered by `desktop-main-terms.test.ts` and `desktop-wallet-terms.test.ts`.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { build } from 'esbuild';

const DESKTOP = join(dirname(fileURLToPath(import.meta.url)), '..', 'desktop');
const CURRENT = '2026-11-06-r2';
const NEXT = '2026-12-01';
const TERMS_URL = (v: string): string => `https://interego.example/terms/${v}/`;
const REFUSAL = 'the relay did not accept this wallet proof (HTTP 428): Review the Hosted Interego Terms of Service and select I agree before creating an account.';

type Offer =
  | { state: 'offered'; version: string; url: string; privacyUrl: string | null; betaNotice: string | null }
  | { state: 'none' }
  | { state: 'unknown'; why: string };

const offered = (v: string): Offer => ({ state: 'offered', version: v, url: TERMS_URL(v), privacyUrl: 'https://interego.example/privacy/', betaNotice: 'Hosted Interego is a beta prototype for testing.' });

let bundle = '';
beforeAll(async () => {
  const out = await build({
    entryPoints: [join(DESKTOP, 'src/renderer.ts')],
    bundle: true, format: 'iife', platform: 'browser', target: 'es2020', write: false, logLevel: 'silent',
  });
  bundle = (out.outputFiles[0] as { text: string }).text;
}, 60_000);

interface Calls {
  wallet: Array<string | undefined>;
  imports: Array<string | undefined>;
  switches: Array<string | undefined>;
  mints: Array<string | undefined>;
  delegateImports: Array<string | undefined>;
  termsReads: number;
}

/**
 * Boot the shipping window with a bridge that records what each sign-in carried, and refuses it —
 * unless `succeed` says this case needs one to complete (a sign-in, a mint), which is how the
 * redraw AFTER a completed use is reached at all.
 */
async function open(opts: {
  offer: Offer | (() => Offer | Promise<Offer>);
  accounts?: number;
  succeed?: { readonly signIn?: boolean; readonly mint?: boolean };
}): Promise<{ doc: Document; calls: Calls }> {
  const html = readFileSync(join(DESKTOP, 'index.html'), 'utf8');
  const dom = new JSDOM('<!doctype html><html><head><meta charset="utf-8"></head><body>' + html + '</body></html>', {
    runScripts: 'outside-only', url: 'file:///app/index.html', pretendToBeVisual: true,
  });
  const win = dom.window as unknown as Window & typeof globalThis;
  const calls: Calls = { wallet: [], imports: [], switches: [], mints: [], delegateImports: [], termsReads: 0 };
  const accounts = Array.from({ length: opts.accounts ?? 0 }, (_, i) => ({
    address: '0x' + String(i + 1).repeat(40).slice(0, 40), pod: null, active: i === 0, unreadable: null,
  }));
  // Every sign-in is REFUSED the way the main process relays a 428, so nothing boots past the
  // sign-in card and what crossed the bridge is the whole of what a case reads.
  const refuse = (): never => { throw new Error(REFUSAL); };
  (win as unknown as Record<string, unknown>)['interego'] = {
    hostedTerms: async () => { calls.termsReads++; return await (typeof opts.offer === 'function' ? opts.offer() : opts.offer); },
    describe: async () => ({
      relay: 'https://relay.interego.xwisee.com', identityServer: 'https://identity.interego.xwisee.com',
      secretStore: true, hasStoredWallet: accounts.length > 0, accounts, signedInAs: null,
      session: { state: 'signed-out', pod: null, method: null, expiresAt: null, renewable: false, why: null },
      watchDescription: 're-read on a timer, not pushed',
    }),
    signInWithWallet: async (v?: string) => {
      calls.wallet.push(v);
      if (!opts.succeed?.signIn) return refuse();
      return { pod: 'u-eth-000000000001', displayName: null, method: 'wallet', address: '0x' + '1'.repeat(40), mintedNewKey: !accounts.length };
    },
    signInWithBrowser: async () => refuse(),
    accountList: async () => ({ accounts, secretStore: true }),
    accountImport: async (_pk: string, v?: string) => { calls.imports.push(v); return refuse(); },
    accountSignInAs: async (_a: string, v?: string) => { calls.switches.push(v); return refuse(); },
    delegateMint: async (v?: string) => {
      calls.mints.push(v);
      if (!opts.succeed?.mint) throw new Error('the relay did not accept this wallet proof (HTTP 428): delegate refused');
      return { address: '0x' + 'd'.repeat(40), agentId: 'did:web:identity.example:agents:delegate-' + calls.mints.length, pod: 'u-eth-dddddddddddd', privateKey: '0x' + 'e'.repeat(64) };
    },
    delegateImport: async (_pk: string, v?: string) => { calls.delegateImports.push(v); throw new Error('refused'); },
    delegateList: async () => ({ delegates: [], secretStore: true }),
    // A completed sign-in boots the workspace; there is no relay in this file, so that boot stops
    // at its first call, on screen, which no case here reads.
    call: async () => { throw new Error('no relay in this test'); },
    signOut: async () => ({ accounts }),
    onSessionChanged: () => {},
    onTurnProgress: () => {},
  };
  win.eval(bundle);
  await settle();
  return { doc: win.document, calls };
}

const settle = async (): Promise<void> => { for (let i = 0; i < 20; i++) await new Promise((r) => { setTimeout(r, 2); }); };
const box = (doc: Document, id: string): HTMLInputElement | null => doc.getElementById(id) as HTMLInputElement | null;
const click = async (doc: Document, id: string): Promise<void> => { (doc.getElementById(id) as HTMLButtonElement).click(); await settle(); };
const text = (doc: Document, id: string): string => doc.getElementById(id)?.textContent ?? '';

describe('the Hosted Terms on the desktop sign-in screen', () => {
  it('★ shows the terms link and version beside an "I agree" box that starts UNTICKED', async () => {
    const { doc } = await open({ offer: offered(CURRENT) });
    const agree = box(doc, 'signin-terms-agree');
    expect(agree).not.toBeNull();
    expect(agree!.checked).toBe(false);
    const link = doc.querySelector('#signin-terms a') as HTMLAnchorElement;
    expect(link.href).toBe(TERMS_URL(CURRENT));
    expect(link.rel).toContain('noopener');
    expect(text(doc, 'signin-terms')).toContain('I am at least 18 and I agree to the Hosted Interego Terms of Service (version ' + CURRENT + ')');
    expect(text(doc, 'signin-terms')).toContain('beta prototype');
  });

  it('★ a press that would MINT a key (none held) is refused before anything crosses, until the box is ticked', async () => {
    const { doc, calls } = await open({ offer: offered(CURRENT) });
    await click(doc, 'signin-wallet');
    expect(calls.wallet).toEqual([]);
    expect(text(doc, 'signinnote')).toContain('tick "I agree" first');
    expect(text(doc, 'signinnote')).toContain('Nothing was minted');
    box(doc, 'signin-terms-agree')!.checked = true;
    await click(doc, 'signin-wallet');
    expect(calls.wallet).toEqual([CURRENT]);
  });

  it('★ a stored key signs in UNTICKED with no version — a returning account never needs one — and ticked with exactly the drawn version', async () => {
    const { doc, calls } = await open({ offer: offered(CURRENT), accounts: 1 });
    await click(doc, 'signin-wallet');
    expect(calls.wallet).toEqual([undefined]);
    box(doc, 'signin-terms-agree')!.checked = true;
    await click(doc, 'signin-wallet');
    expect(calls.wallet).toEqual([undefined, CURRENT]);
  });

  it('a pasted key carries the tick, and only the tick', async () => {
    const { doc, calls } = await open({ offer: offered(CURRENT) });
    const key = '0x' + '4'.repeat(64);
    (doc.getElementById('signin-importkey') as HTMLInputElement).value = key;
    await click(doc, 'signin-import');
    box(doc, 'signin-terms-agree')!.checked = true;
    (doc.getElementById('signin-importkey') as HTMLInputElement).value = key;
    await click(doc, 'signin-import');
    expect(calls.imports).toEqual([undefined, CURRENT]);
  });

  it('★ the server\'s refusal reaches the screen in its own words', async () => {
    const { doc } = await open({ offer: offered(CURRENT), accounts: 1 });
    await click(doc, 'signin-wallet');
    expect(text(doc, 'signinnote')).toContain('(HTTP 428): Review the Hosted Interego Terms of Service');
  });

  it('★ a NEW version after a refusal is redrawn UNTICKED, and an agreement to the old one is never sent for it', async () => {
    let current = CURRENT;
    const { doc, calls } = await open({ offer: () => offered(current), accounts: 1 });
    box(doc, 'signin-terms-agree')!.checked = true;
    current = NEXT;
    await click(doc, 'signin-wallet');
    expect(calls.wallet).toEqual([CURRENT]);
    // The refusal re-read the terms: the version moved, so the box is a new one, empty.
    const agree = box(doc, 'signin-terms-agree')!;
    expect(agree.checked).toBe(false);
    expect(agree.dataset['version']).toBe(NEXT);
    await click(doc, 'signin-wallet');
    expect(calls.wallet).toEqual([CURRENT, undefined]);
  });

  it('an unreadable offer says so, and does not stop a returning account', async () => {
    const { doc, calls } = await open({ offer: { state: 'unknown', why: 'the identity server answered HTTP 503' }, accounts: 1 });
    expect(box(doc, 'signin-terms-agree')).toBeNull();
    expect(text(doc, 'signin-terms')).toContain('could not be read (the identity server answered HTTP 503)');
    await click(doc, 'signin-wallet');
    expect(calls.wallet).toEqual([undefined]);
  });

  it('a deployment that offers no terms draws no box and asks for nothing', async () => {
    const { doc, calls } = await open({ offer: { state: 'none' } });
    expect(text(doc, 'signin-terms')).toBe('');
    await click(doc, 'signin-wallet');
    expect(calls.wallet).toEqual([undefined]);
  });

  it('★ a press that would mint WAITS for an offer still being read, and is refused when it turns out to need a tick', async () => {
    let answer!: (o: Offer) => void;
    const { doc, calls } = await open({ offer: () => new Promise<Offer>((r) => { answer = r; }) });
    expect(box(doc, 'signin-terms-agree')).toBeNull();
    await click(doc, 'signin-wallet');
    // Nothing crosses while the offer is unknown, and the card cannot be pressed twice meanwhile.
    expect(calls.wallet).toEqual([]);
    expect((doc.getElementById('signin-wallet') as HTMLButtonElement).disabled).toBe(true);
    answer(offered(CURRENT));
    await settle();
    expect(calls.wallet).toEqual([]);
    expect(text(doc, 'signinnote')).toContain('tick "I agree" first');
    expect(box(doc, 'signin-terms-agree')!.checked).toBe(false);
    expect((doc.getElementById('signin-wallet') as HTMLButtonElement).disabled).toBe(false);
  });

  it('a press that would mint waits for the offer and goes on when the deployment offers none', async () => {
    let answer!: (o: Offer) => void;
    const { doc, calls } = await open({ offer: () => new Promise<Offer>((r) => { answer = r; }) });
    await click(doc, 'signin-wallet');
    expect(calls.wallet).toEqual([]);
    answer({ state: 'none' });
    await settle();
    expect(calls.wallet).toEqual([undefined]);
  });

  it('★ with no key held, an UNREADABLE offer refuses the minting press and reads the terms again — "could not tell" is not "none needed"', async () => {
    const { doc, calls } = await open({ offer: { state: 'unknown', why: 'the identity server answered HTTP 503' } });
    const before = calls.termsReads;
    await click(doc, 'signin-wallet');
    expect(calls.wallet).toEqual([]);
    expect(text(doc, 'signinnote')).toContain('could not be read');
    expect(text(doc, 'signinnote')).toContain('the identity server answered HTTP 503');
    expect(text(doc, 'signinnote')).toContain('Nothing was minted and nothing was sent');
    expect(calls.termsReads).toBeGreaterThan(before);
  });

  it('★ the sign-in box is redrawn UNTICKED after a completed sign-in, and again on sign-out', async () => {
    const { doc, calls } = await open({ offer: offered(CURRENT), succeed: { signIn: true } });
    box(doc, 'signin-terms-agree')!.checked = true;
    await click(doc, 'signin-wallet');
    expect(calls.wallet).toEqual([CURRENT]);
    expect(doc.getElementById('signin')!.hidden).toBe(true);
    expect(box(doc, 'signin-terms-agree')!.checked).toBe(false);
    // Ticked again while signed in (both boxes), then signed out: the card comes back empty.
    box(doc, 'signin-terms-agree')!.checked = true;
    box(doc, 'delegate-terms-agree')!.checked = true;
    await click(doc, 'signoutbtn');
    expect(doc.getElementById('signin')!.hidden).toBe(false);
    expect(box(doc, 'signin-terms-agree')!.checked).toBe(false);
    expect(box(doc, 'delegate-terms-agree')!.checked).toBe(false);
  });
});

describe('a minted delegate\'s own agreement', () => {
  it('★ minting is refused until the DELEGATE panel\'s own box is ticked — the sign-in screen\'s tick does not carry over', async () => {
    const { doc, calls } = await open({ offer: offered(CURRENT), accounts: 1 });
    expect(box(doc, 'delegate-terms-agree')!.checked).toBe(false);
    box(doc, 'signin-terms-agree')!.checked = true;
    await click(doc, 'delegatemint');
    expect(calls.mints).toEqual([]);
    expect(text(doc, 'delegateresult')).toContain('your agreement for your own account does not carry over');
    box(doc, 'delegate-terms-agree')!.checked = true;
    await click(doc, 'delegatemint');
    expect(calls.mints).toEqual([CURRENT]);
    expect(text(doc, 'delegateresult')).toContain('(HTTP 428): delegate refused');
  });

  it('★ a tick is used ONCE: after a mint the box is unticked, and a second Mint without a fresh tick sends nothing', async () => {
    for (const succeed of [false, true]) {
      const { doc, calls } = await open({ offer: offered(CURRENT), accounts: 1, succeed: { mint: succeed } });
      box(doc, 'delegate-terms-agree')!.checked = true;
      await click(doc, 'delegatemint');
      expect(calls.mints).toEqual([CURRENT]);
      expect(box(doc, 'delegate-terms-agree')!.checked).toBe(false);
      await click(doc, 'delegatemint');
      expect(calls.mints).toEqual([CURRENT]);
      expect(text(doc, 'delegateresult')).toContain('tick "I agree" first');
    }
  });

  it('a delegate adoption uses the tick once too: the next one carries no version without a fresh tick', async () => {
    const { doc, calls } = await open({ offer: offered(CURRENT), accounts: 1 });
    const key = '0x' + '5'.repeat(64);
    box(doc, 'delegate-terms-agree')!.checked = true;
    (doc.getElementById('delegateimportkey') as HTMLInputElement).value = key;
    await click(doc, 'delegateimport');
    expect(box(doc, 'delegate-terms-agree')!.checked).toBe(false);
    (doc.getElementById('delegateimportkey') as HTMLInputElement).value = key;
    await click(doc, 'delegateimport');
    expect(calls.delegateImports).toEqual([CURRENT, undefined]);
  });

  it('minting a delegate while the offer cannot be read is refused, and nothing crosses', async () => {
    const { doc, calls } = await open({ offer: { state: 'unknown', why: 'the identity server answered HTTP 503' }, accounts: 1 });
    await click(doc, 'delegatemint');
    expect(calls.mints).toEqual([]);
    expect(text(doc, 'delegateresult')).toContain('could not be read');
    expect(text(doc, 'delegateresult')).toContain('Nothing was minted');
  });

  it('adopting a delegate key carries the delegate box\'s tick, and nothing without it', async () => {
    const { doc, calls } = await open({ offer: offered(CURRENT), accounts: 1 });
    const key = '0x' + '5'.repeat(64);
    (doc.getElementById('delegateimportkey') as HTMLInputElement).value = key;
    await click(doc, 'delegateimport');
    box(doc, 'delegate-terms-agree')!.checked = true;
    (doc.getElementById('delegateimportkey') as HTMLInputElement).value = key;
    await click(doc, 'delegateimport');
    expect(calls.delegateImports).toEqual([undefined, CURRENT]);
  });
});
