/**
 * DRIVE THE REAL APP, WITH A REAL KEY, AGAINST THE LIVE FLEET — AND LOOK AT WHAT IT DREW.
 *
 * ★ WHY THIS EXISTS AND WHAT IT REPLACES. `selftest.ts` runs the desktop's main-process modules
 * against the live relay and says so in its own header: "What it does NOT cover is the renderer —
 * a window nobody looked at is not evidence a window works." The change this drives is precisely a
 * renderer change (a field, a button, a keyring, a sign-out), and its whole claim is a CROSS-SURFACE
 * one: a workspace created from Discord must appear in the desktop client, because neither owns it
 * — the pod does. Nothing that stops at the main process can establish that.
 *
 * ★ SO NOTHING HERE IS A STAND-IN FOR ANYTHING UNDER TEST. It imports `../src/main.js`, which is the
 * shipping main process: every IPC handler, the real `createWindow`, the real preload, the real
 * `index.html`, the real bundled renderer, the real `safeStorage`, the real SIWE ceremony against
 * `https://relay.interego.xwisee.com`. The ONLY thing replaced is the hand: this types into the
 * real field and clicks the real button, then reads the real DOM back.
 *
 *   INTEREGO_DRIVE_KEY_FILE=<path>   a JSON file with a `privateKey`, or a file holding one 0x key
 *   INTEREGO_DRIVE_EXPECT_POD=<pod>  the pod the sign-in must reach, e.g. u-eth-8f3b8e939600
 *   INTEREGO_DRIVE_EXPECT_WS=<iri>   a workspace IRI that must appear in the lobby
 *   INTEREGO_DRIVE_EXPECT_ENTRY=<s>  text that must appear in that workspace's stream
 *
 * Run (from `applications/shared-workspace/desktop`, after `npm run build`):
 *   npx electron dist/drive-account-import-live.js
 *
 * ★ THE KEY IS NEVER PRINTED, NEVER LOGGED, AND NEVER WRITTEN ANYWHERE BUT THE OS SECRET STORE.
 * It is read from the file the operator names, handed to the renderer's own input exactly as a
 * paste would be, and the app stores it the one way it stores any key. Nothing below echoes it, and
 * the checks that read the document assert its ABSENCE from what was drawn.
 */

import { app, BrowserWindow } from 'electron';
import { readFileSync } from 'node:fs';
// Importing the shipping main process is what makes this a drive of the app rather than a
// re-implementation of it: the side effect of this import is the real app starting.
import '../src/main.js';

const log = (...a: unknown[]): void => { process.stdout.write(a.map(String).join(' ') + '\n'); };

/** Read the key out of whatever shape the file is in. Never returned to anything that prints. */
function readKey(path: string): string {
  const raw = readFileSync(path, 'utf8').trim();
  if (raw.startsWith('{')) {
    const j = JSON.parse(raw) as { privateKey?: string };
    if (!j.privateKey) throw new Error('that JSON file has no `privateKey` field');
    return j.privateKey.trim();
  }
  return raw;
}

/** Wait for a predicate evaluated IN THE PAGE, polling the real document. */
async function until(win: BrowserWindow, what: string, expression: string, timeoutMs = 120_000): Promise<string> {
  const t0 = Date.now();
  for (;;) {
    const got = await win.webContents.executeJavaScript(expression) as string | null;
    if (got) return got;
    if (Date.now() - t0 > timeoutMs) throw new Error('timed out after ' + Math.round((Date.now() - t0) / 1000) + 's waiting for ' + what);
    await new Promise((r) => { setTimeout(r, 500); });
  }
}

/** The one window the shipping main process opened. Not a new one — that would be a different app. */
async function theWindow(): Promise<BrowserWindow> {
  for (let i = 0; i < 120; i++) {
    const [win] = BrowserWindow.getAllWindows();
    if (win) {
      if (win.webContents.isLoading()) await new Promise<void>((r) => { win.webContents.once('did-finish-load', () => { r(); }); });
      return win;
    }
    await new Promise((r) => { setTimeout(r, 250); });
  }
  throw new Error('the main process did not open a window');
}

async function drive(): Promise<number> {
  const keyFile = process.env['INTEREGO_DRIVE_KEY_FILE'];
  const wantPod = process.env['INTEREGO_DRIVE_EXPECT_POD'] ?? '';
  const wantWs = process.env['INTEREGO_DRIVE_EXPECT_WS'] ?? '';
  const wantEntry = process.env['INTEREGO_DRIVE_EXPECT_ENTRY'] ?? '';
  if (!keyFile) { log('INTEREGO_DRIVE_KEY_FILE is unset, so there is no key to drive with'); return 2; }
  const key = readKey(keyFile);

  const win = await theWindow();
  log('window                 : the shipping main process opened it and it finished loading');

  // The sign-in card must be on screen and must be offering the new affordance. Asserted rather
  // than assumed: a drive that typed into a field that was not there would report a different bug.
  const offered = await win.webContents.executeJavaScript(
    'JSON.stringify({field: !!document.getElementById("signin-importkey"), button: !!document.getElementById("signin-import"),'
    + ' signinVisible: !document.getElementById("signin").hidden})') as string;
  log('sign-in card           :', offered);
  if (!JSON.parse(offered).field) { log('the shipping index.html has no account-key field'); return 3; }

  // ★ THE GESTURE, AND NOTHING ELSE. The key goes into the app's own input and the app's own button
  // is pressed; every line of validation, IPC, storage and SIWE below that is the shipping path.
  const t0 = Date.now();
  await win.webContents.executeJavaScript(
    'document.getElementById("signin-importkey").value = ' + JSON.stringify(key) + ';'
    + 'document.getElementById("signin-import").click(); true;');

  // The hint element carries a refusal; the header carries the pod. Whichever appears first is the
  // answer, so both are watched — waiting only for success would report a refusal as a timeout.
  const outcome = await until(win, 'the sign-in to resolve',
    '(function(){var w=document.getElementById("whoami").textContent||"";'
    + 'var h=document.getElementById("signin-importhint").textContent||"";'
    + 'var n=document.getElementById("signinnote").textContent||"";'
    + 'if(w) return "POD:"+w; if(h) return "REFUSED:"+h; if(n.indexOf("did not")>=0||n.indexOf("could not")>=0) return "FAILED:"+n;'
    + 'return "";})()');
  log('sign-in                :', outcome.slice(0, 300), '·', ((Date.now() - t0) / 1000).toFixed(1) + 's');
  if (!outcome.startsWith('POD:')) { log('the app did not sign in'); return 4; }
  const pod = outcome.slice(4);
  if (wantPod && pod !== wantPod) { log('WRONG IDENTITY — expected', wantPod, 'and the app reached', pod); return 5; }
  log('identity               :', pod, wantPod ? '· matches the pod this key owns' : '');

  // ★ AND THE KEY IS NOT IN THE DOCUMENT. The app cleared the field; this checks the whole rendered
  // page, because a success message that quoted the key would be a private key on screen.
  const leaked = await win.webContents.executeJavaScript(
    'document.body.textContent.indexOf(' + JSON.stringify(key.replace(/^0x/, '')) + ') >= 0'
    + ' || Array.from(document.querySelectorAll("input,textarea")).some(function(i){return i.value.indexOf('
    + JSON.stringify(key.replace(/^0x/, '')) + ')>=0;})') as boolean;
  log('key on screen          :', leaked ? 'YES — THE KEY IS IN THE DOCUMENT' : 'no');
  if (leaked) return 6;

  if (!wantWs) { log('no INTEREGO_DRIVE_EXPECT_WS — stopping after identity'); return 0; }

  // ★ THE CROSS-SURFACE CLAIM. This workspace was created from Discord. It is in the lobby here for
  // one reason: it is on the pod, and neither client owns it.
  const listed = await until(win, 'the lobby to list the workspace made from Discord',
    '(function(){var t=document.getElementById("lobby").textContent||"";'
    + 'return t.indexOf(' + JSON.stringify(wantWs) + ')>=0 ? "listed" : "";})()');
  log('workspace in the lobby :', listed, '·', wantWs);
  // ★ AND WHETHER THE READ THAT FOUND IT WAS A WHOLE READ. This pod's manifest is bounded with
  // archive segments, and a client that silently stopped at the first page would show a SUBSET of
  // somebody's workspaces while looking exactly like a complete list. The shell says so when it
  // hits its cap; that sentence is what is looked for here, and its absence is the evidence.
  log('lobby completeness     :', await win.webContents.executeJavaScript(
    '(function(){var n=document.getElementById("wsnote").textContent||"";'
    + 'return document.querySelectorAll("#wslist > *").length+" workspace row(s) · "+n;})()'));

  // Open it the way a person does — by its IRI — and read what the channel actually drew.
  await win.webContents.executeJavaScript(
    'document.getElementById("wsopen").value = ' + JSON.stringify(wantWs) + ';'
    + 'document.getElementById("openbtn").click(); true;');
  const title = await until(win, 'the workspace record to be read',
    '(function(){return document.getElementById("wstitle").textContent||"";})()');
  log('workspace title        :', JSON.stringify(title));

  if (!wantEntry) return 0;
  const entry = await until(win, 'the entry written from Discord to appear in the stream',
    '(function(){var t=document.getElementById("stream").textContent||"";'
    + 'return t.indexOf(' + JSON.stringify(wantEntry) + ')>=0 ? "present" : "";})()');
  log('entry from Discord     :', entry, '·', JSON.stringify(wantEntry));
  return 0;
}

void app.whenReady().then(async () => {
  let code = 1;
  try { code = await drive(); }
  catch (e) { log('THREW:', (e as Error)?.message ?? String(e)); code = 1; }
  log(code === 0 ? '\nDRIVE OK' : '\nDRIVE FAILED (' + code + ')');
  app.exit(code);
  // A helper that outlives `app.exit()` holds this launcher's stdout open; the same reason
  // `runLaunchSmoke` forces the exit.
  setTimeout(() => process.exit(code), 3000).unref();
});
