/**
 * DOES A DELEGATE KEY THIS MACHINE ALREADY HOLDS RESOLVE TO AN AGENT ID ON A COLD START?
 *
 * ── THE DEFECT THIS EXISTS TO CATCH ──────────────────────────────────────────
 *
 * `delegate:list` reported `agentId: null` for any delegate that had not signed in during the
 * CURRENT run, on the sound principle that a computed id would be this process asserting what the
 * relay would answer. But the map it consulted is per-run, so after every restart it was empty —
 * and the renderer, which matches a held key to a pod's registry row BY AGENT ID, drew "no key on
 * this machine" and DISABLED the option. The id only becomes known by signing the delegate in,
 * which needs the option that is disabled. A delegate stopped working the moment the app closed.
 *
 * MEASURED 2026-08-11: a delegate minted and authorised at 16:20 was unusable by 21:40, with its
 * key present in `secrets/delegate-0x03f52e15b9df….bin` the whole time. The app said the key was
 * not on the machine while holding it.
 *
 * ── WHAT THIS PROVES, AND WHAT IT DOES NOT ───────────────────────────────────
 *
 * ★ IT PROVES THE PROPERTY THE FIX DEPENDS ON: that a key sitting in the secret store, with no
 * session anywhere in memory, can be signed in against the live relay and come back with the
 * agent id the renderer needs. That is the question `delegate:list` now asks instead of giving up.
 *
 * ★ IT DOES NOT DRIVE THE IPC HANDLER ITSELF. That lives inside `main.ts`, which opens windows on
 * import. `tests/workspace-desktop-renderer.test.ts` cannot see this either — it scripts
 * `window.interego` wholesale, so the harness would supply the very agent id whose absence IS the
 * defect. A harness that stands in for the dependency cannot verify it.
 *
 * It uses the same `secrets` module and the same `auth` primitives the app uses, against the real
 * relay. Read-only with respect to pods: it opens sessions, which is what the app does at startup,
 * and writes nothing.
 *
 * Run: npm run drive:delegates   (from applications/shared-workspace/desktop)
 */
import { app } from 'electron';
import { Wallet } from 'ethers';
import { DELEGATE_SURFACE, RelayMcpTransport, WorkspaceClient } from '@interego/workspace-client';
import { signInWithWallet, startLoopbackReceiver } from '../src/auth.js';
import { DELEGATE_KEY, getSecret, listDelegateKeys, secretStoreAvailable } from '../src/secrets.js';

const RELAY = process.env['INTEREGO_RELAY'] ?? 'https://relay.interego.xwisee.com';
const IDENTITY = process.env['INTEREGO_IDENTITY'] ?? 'https://identity.interego.xwisee.com';

/**
 * ★ THE PACKAGED APP'S OWN STORE, NAMED EXPLICITLY, OR THIS DRIVER CHECKS NOTHING.
 *
 * Electron derives `userData` from the app NAME, and a script launched as `electron dist/x.js`
 * gets the default name — so the first run of this reported `userData: …\Roaming\Electron` and
 * "delegate keys on disk: 0" against a machine that plainly held one. Zero keys reads exactly
 * like a clean pass. Must match the `name` in this package's package.json, which is what
 * electron-builder gives the installed app.
 */
const APP_NAME = '@interego/workspace-desktop';
app.setName(APP_NAME);

async function main(): Promise<void> {
  // ★ THE PATH IS PRINTED BECAUSE A DRIVER LOOKING IN THE WRONG STORE REPORTS "no keys" — which
  // is indistinguishable from the app holding none, and would have read as a passing run.
  console.log('userData               : ' + app.getPath('userData'));
  console.log('secret store available : ' + secretStoreAvailable());
  const addresses = listDelegateKeys();
  console.log('delegate keys on disk  : ' + addresses.length);
  if (!addresses.length) {
    console.log('\nNothing to check — mint a delegate in the app first.');
    app.exit(0);
    return;
  }

  let bad = 0;
  for (const address of addresses) {
    console.log('\n  ' + address);
    const pk = getSecret(DELEGATE_KEY(address.toLowerCase()));
    if (!pk) { bad++; console.log('    ✗ the store lists this address and holds no key for it'); continue; }
    const wallet = new Wallet(pk);
    const recv = await startLoopbackReceiver();
    try {
      const bearer = await signInWithWallet(
        RELAY, IDENTITY, wallet.address, (m: string) => wallet.signMessage(m), recv.redirectUri, DELEGATE_SURFACE);
      const client = new WorkspaceClient(RELAY, new RelayMcpTransport(RELAY, bearer));
      await client.connect();
      const status = await client.podStatus();
      const agent = status['sessionAgent'] as { did?: string; id?: string } | undefined;
      const agentId = agent?.did ?? agent?.id ?? '';
      const podUrl = String(status['pod'] ?? status['podUrl'] ?? '');
      const pod = podUrl.replace(/\/$/, '').split('/').pop() ?? '';
      if (!agentId || !pod) { bad++; console.log('    ✗ signed in and the relay named no ' + (pod ? 'sessionAgent' : 'pod')); continue; }
      console.log('    ✓ agentId : ' + agentId);
      console.log('      own pod : ' + pod);
    } catch (e) {
      bad++;
      console.log('    ✗ could not open a session: ' + ((e as Error)?.message ?? String(e)));
    } finally { recv.close(); }
  }

  console.log(bad
    ? '\n' + bad + ' problem(s) — a stored delegate key that cannot resolve an id is a delegate the app will call "no key on this machine"'
    : '\nevery stored delegate key resolves to an agent id from a cold start, which is what `delegate:list` now reports');
  app.exit(bad ? 1 : 0);
}

void app.whenReady().then(main).catch((e: unknown) => {
  console.error('driver failed: ' + ((e as Error)?.stack ?? String(e)));
  app.exit(1);
});
