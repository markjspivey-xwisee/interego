/**
 * A headless run of the desktop shell's OWN main-process modules against the LIVE relay.
 *
 * ★ WHY THIS EXISTS AND WHAT IT IS NOT. It is not a mock and it is not a stand-in: it loads
 * under Electron, so `safeStorage` is the real OS secret store, `auth.ts` runs the real SIWE
 * ceremony against `https://relay.interego.xwisee.com`, and every read and write goes over
 * `RelayMcpTransport` to `POST /mcp` with a bearer the relay minted. The only thing it
 * replaces is the human: it presses the buttons.
 *
 * What it does NOT cover is the renderer — a window nobody looked at is not evidence a window
 * works — so it is a check on the substrate half, and the shell is run by hand beside it.
 *
 *   INTEREGO_SELFTEST_KEY=0x…            a secp256k1 key to put in the OS store and sign with
 *   INTEREGO_SELFTEST_WORKSPACE=https://… the workspace to open
 *   INTEREGO_SELFTEST_POST=1              also append an entry (a real, public write)
 *
 * Run:  npx electron dist/selftest.js
 */

import { app } from 'electron';
import { Wallet } from 'ethers';
import {
  RelayMcpTransport, WorkspaceClient, foldRoster, graphRegion, orderChain,
  parseWorkspaceIri, postEntry, readLiteral, toChainRow,
} from '@interego/workspace-client';
import { beginAuthorization, exchangeCode, signInWithWallet, startLoopbackReceiver } from './auth.js';
import { getSecret, putSecret, secretStoreAvailable, WALLET_KEY } from './secrets.js';

const RELAY = process.env['INTEREGO_RELAY'] ?? 'https://relay.interego.xwisee.com';
const IDENTITY = process.env['INTEREGO_IDENTITY'] ?? 'https://identity.interego.xwisee.com';

const log = (...a: unknown[]): void => { process.stdout.write(a.map(String).join(' ') + '\n'); };

/**
 * A WebAuthn assertion, produced here ONLY to stand in for the user's finger on the sensor.
 *
 * ★ WHAT THIS DOES AND DOES NOT PROVE. Everything around it is the shipping code: the desktop
 * registers its own OAuth client, opens a real authorization, listens on a real loopback
 * socket and exchanges the code with PKCE. What is replaced is the gesture — the platform
 * authenticator — because a Windows Hello prompt cannot be answered by a script. In the app
 * the ceremony happens in the SYSTEM BROWSER, on the relay's own sign-in page, for the reason
 * this function's `ORIGIN` records.
 *
 * ★ THE MEASURED GOTCHA, WHICH IS WHY THE APP DELEGATES TO A BROWSER AT ALL.
 * `clientDataJSON.origin` must be `https://identity.interego.xwisee.com` — the IDENTITY
 * server — even though the proof is POSTed to the RELAY's `/oauth/verify`. Run with the
 * relay's origin, the ceremony is rejected. An Electron renderer loaded from `file://` has
 * origin `file://` and can never satisfy it, so an in-app ceremony is not merely harder, it
 * is impossible without hosting the page at that origin.
 */
async function passkeyAssertion(credFile: string, challengeB64u: string): Promise<Record<string, unknown>> {
  const { createHash, createSign } = await import('node:crypto');
  const { readFileSync } = await import('node:fs');
  const RP_ID = 'interego.xwisee.com';
  const ORIGIN = 'https://identity.interego.xwisee.com';
  const s = JSON.parse(readFileSync(credFile, 'utf8')) as { credId: string; privateKeyPem: string };
  const credId = Buffer.from(s.credId, 'base64url');
  const rpIdHash = createHash('sha256').update(RP_ID).digest();
  const flags = Buffer.from([0x01 | 0x04]);                    // UP | UV, no attested data
  // ★ MEASURED: the relay enforces WebAuthn's signature counter and refuses a replay with
  // "Response counter value 1 was lower than expected 1". A real authenticator keeps its own
  // monotonic counter; this stand-in derives one from the clock so a second run is not a
  // replay of the first.
  const counter = Buffer.alloc(4); counter.writeUInt32BE(Math.floor(Date.now() / 1000) % 0xffffffff);
  const authData = Buffer.concat([rpIdHash, flags, counter]);
  const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: challengeB64u, origin: ORIGIN, crossOrigin: false }), 'utf8');
  const signed = Buffer.concat([authData, createHash('sha256').update(clientDataJSON).digest()]);
  const sig = createSign('SHA256').update(signed).sign({ key: s.privateKeyPem, dsaEncoding: 'der' });
  return {
    id: credId.toString('base64url'), rawId: credId.toString('base64url'), type: 'public-key',
    response: {
      authenticatorData: authData.toString('base64url'),
      clientDataJSON: clientDataJSON.toString('base64url'),
      signature: sig.toString('base64url'), userHandle: null,
    },
    clientExtensionResults: {},
  };
}

/** Drive the desktop's browser-delegated path with the gesture scripted. See above. */
async function passkeyRun(credFile: string): Promise<number> {
  const recv = await startLoopbackReceiver(60_000);
  log('loopback receiver      :', recv.redirectUri);
  try {
    const pending = await beginAuthorization(RELAY, 'interego-workspace-desktop', recv.redirectUri);
    log('authorize url          :', pending.authorizeUrl.slice(0, 96) + '…');
    log('pending id             :', pending.pendingId ? 'present' : 'ABSENT');
    const ch = await (await fetch(IDENTITY + '/challenges', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ purpose: 'webauthn-authenticate' }),
    })).json() as { nonce?: string };
    if (!ch.nonce) { log('the identity server issued no WebAuthn challenge'); return 8; }
    const response = await passkeyAssertion(credFile, ch.nonce);
    const vres = await fetch(RELAY + '/oauth/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pending_id: pending.pendingId, method: 'webauthn-authenticate', response }),
    });
    const vj = await vres.json() as { redirect?: string; error?: string; message?: string };
    if (!vj.redirect) { log('the relay refused the passkey proof:', JSON.stringify(vj).slice(0, 300)); return 9; }
    log('oauth/verify           :', vres.status, '· redirected to the loopback receiver');
    // The browser would follow this; here the app follows it, so the receiver sees the code
    // exactly as it would in the shipping path.
    await fetch(vj.redirect).catch(() => undefined);
    const code = await recv.code;
    const bearer = await exchangeCode(RELAY, pending, code, 'webauthn');
    log('bearer                 :', bearer.kind, '· method', bearer.method, '· length', bearer.accessToken.length);
    const client = new WorkspaceClient(RELAY, new RelayMcpTransport(RELAY, bearer));
    await client.connect();
    const status = await client.podStatus();
    const podUrl = String(status['pod'] ?? status['podUrl'] ?? '');
    log('pod                    :', podUrl.replace(/\/$/, '').split('/').pop(), '· displayName', String(status['displayName'] ?? '(none reported)'));
    return 0;
  } finally { recv.close(); }
}

async function run(): Promise<number> {
  const credFile = process.env['INTEREGO_SELFTEST_PASSKEY'];
  if (credFile) return passkeyRun(credFile);
  log('secret store available :', secretStoreAvailable());
  if (!secretStoreAvailable()) { log('REFUSED — no OS secret store, and a plaintext key is not an option'); return 2; }

  const seed = process.env['INTEREGO_SELFTEST_KEY'];
  if (seed) putSecret(WALLET_KEY, seed);
  const pk = getSecret(WALLET_KEY) ?? (() => { const w = Wallet.createRandom(); putSecret(WALLET_KEY, w.privateKey); return w.privateKey; })();
  const wallet = new Wallet(pk);
  log('wallet address         :', wallet.address, '(key read back out of the OS secret store)');

  const t0 = Date.now();
  const recv = await startLoopbackReceiver();
  log('loopback receiver      :', recv.redirectUri);
  let bearer;
  try {
    bearer = await signInWithWallet(RELAY, IDENTITY, wallet.address, (m) => wallet.signMessage(m), recv.redirectUri);
  } finally { recv.close(); }
  log('bearer                 :', bearer.kind, '· method', bearer.method, '· length', bearer.accessToken.length,
    '· expiresAt', bearer.expiresAt === null ? 'not reported by the grant' : new Date(bearer.expiresAt).toISOString());

  const transport = new RelayMcpTransport(RELAY, bearer);
  const client = new WorkspaceClient(RELAY, transport);
  const { granted } = await client.connect();
  log('tools reachable        :', granted.length);

  const status = await client.podStatus();
  const podUrl = String(status['pod'] ?? status['podUrl'] ?? '');
  const pod = podUrl.replace(/\/$/, '').split('/').pop() ?? '';
  // The WebID this pod's own registry reports. Every entry now states its author, so a post
  // cannot be composed without it — and a guessed one would attribute a permanent record wrongly.
  const registry = status['registry'] as { owner?: string } | undefined;
  const delegation = status['delegationRegistry'] as { owner?: string } | undefined;
  const webId = registry?.owner ?? delegation?.owner ?? '';
  log('pod                    :', pod, '· webId', webId || '(none reported)', '· cold start', ((Date.now() - t0) / 1000).toFixed(1) + 's');
  if (!pod) return 3;

  const wsIri = process.env['INTEREGO_SELFTEST_WORKSPACE'];
  if (!wsIri) { log('no INTEREGO_SELFTEST_WORKSPACE — stopping after identity'); return 0; }
  const parts = parseWorkspaceIri(RELAY, wsIri);
  if (!parts) { log('not a workspace IRI on this relay:', wsIri); return 4; }

  const read = await client.readWorkspaceRecord(wsIri, parts.owner);
  if (read.kind !== 'record') { log('workspace record       :', read.kind, '·', 'message' in read ? read.message : ''); return 5; }
  log('workspace              :', JSON.stringify(read.record.title), '· convener pod', read.record.convenerPod);
  log('entryShape             :', read.record.entryShape ?? '(the record was read and names none)');

  const fold = await foldRoster(client, {
    workspace: wsIri, iriOwner: parts.owner, slug: parts.slug,
    convener: read.record.convener, convenerPod: read.record.convenerPod,
  });
  log('roster                 :', fold.seats.length, 'grants ·', fold.seats.filter((s) => s.seated).length, 'seated',
    '· grants found', fold.grantsFound, '· read', fold.grantsRead);
  for (const s of fold.seats) log('   ', s.seated ? 'SEATED ' : 'not    ', s.pod, '·', s.seated ? s.acceptTest : s.why);

  let entries = 0;
  for (const s of fold.seats) {
    if (!s.seated || !s.stream || !s.pod) continue;
    const rows = (await client.manifest(s.pod, s.stream)).map(toChainRow);
    const walk = orderChain(rows);
    log('   log', s.pod, '·', rows.length, 'rows · walked', walk.walked, walk.forked ? '· FORKED' : '');
    for (const r of walk.ordered) {
      const d = await client.descriptor(r.url);
      const region = graphRegion((d['graph'] as { content?: string } | undefined)?.content ?? '', s.stream);
      log('      ', JSON.stringify(readLiteral(region === null ? '' : region, 'dct:description')));
      entries++;
    }
  }
  log('entries read           :', entries);

  if (process.env['INTEREGO_SELFTEST_POST'] === '1') {
    const seat = fold.seats.find((s) => s.seated && s.pod === pod && s.stream);
    const streamIri = seat?.stream ?? RELAY + '/ns/' + pod + '/' + parts.owner + '--' + parts.slug + '-stream';
    const body = 'Posted from the Interego desktop shell at ' + new Date().toISOString()
      + ' — same @interego/workspace-client the published artifact runs, different transport.';
    // The person is the author here: this selftest signs in as them and writes what it composed
    // under their own name deliberately, to exercise the ordinary path. A delegate's write is a
    // different author and a different session — `tools/drive-delegate-live.ts` drives that one.
    const out = await postEntry(client, {
      podName: pod, streamIri, workspace: wsIri, body,
      author: { kind: 'principal', webId },
      entryShape: read.record.entryShape,
    });
    log('post                   :', out.kind);
    if (out.kind === 'accepted') {
      log('   seq', out.seq, '· descriptor', out.descriptorUrl, '· committed', out.committed);
      log('   shape sent', out.shapeSent ?? '(none — the record names none)');
      const auth = out.response['authorship'] as { signed?: boolean; signer?: string } | undefined;
      log('   authorship', auth ? (auth.signed ? 'signed by ' + auth.signer : 'NOT signed') : 'the response reported no authorship block');
      // ★ CONFIRM IT IS READABLE BACK. The acknowledgement is not the check.
      let landed = false;
      for (let i = 0; i < 30 && !landed; i++) {
        await new Promise((r) => setTimeout(r, 700));
        const rows = (await client.manifest(pod, streamIri)).map(toChainRow);
        landed = rows.some((r) => r.url === out.descriptorUrl);
      }
      log('   read back on', pod, ':', landed ? 'YES' : 'not within the wait — NOT being called posted on that basis');
      if (!landed) return 6;
    } else {
      log('   ', JSON.stringify(out).slice(0, 400));
      return 7;
    }
  }
  return 0;
}

void app.whenReady().then(async () => {
  let code = 1;
  try { code = await run(); }
  catch (e) { log('THREW:', (e as Error)?.stack ?? String(e)); code = 1; }
  log(code === 0 ? '\nSELFTEST OK' : '\nSELFTEST FAILED (' + code + ')');
  app.exit(code);
});
