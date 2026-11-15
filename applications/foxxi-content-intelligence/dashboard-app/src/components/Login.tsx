import React, { useEffect, useState } from 'react';
import { ethers } from 'ethers';
import { Card, Button, Pill } from './common.js';
import {
  adminSessionOption, learnerSessionOptions, connectAsGuest, connectFromExtension, connectFromPrivateKey, sessionFromOption,
  type SessionRole, type FoxxiSession,
} from '../auth/session.js';
import { walletExtension } from '../auth/signer.js';
import {
  browserGuestDeps, durableGuestOffer, forgetKeptGuest, keepGuest, keptGuest, openKeptGuest, type DurableGuestOffer,
} from '../auth/durable-guest.js';
import { SAMPLE_TENANT_POD_URL } from '../sample/data.js';

/** The bridge this dashboard talks to; its /start page says what can be done here. */
const BRIDGE_BASE = ((import.meta.env.VITE_FOXXI_BRIDGE_URL as string | undefined) ?? 'https://foxxi-bridge.interego.xwisee.com').replace(/\/$/, '');

export function Login({ onSignIn }: { onSignIn: (s: FoxxiSession) => void }) {
  const [role, setRole] = useState<SessionRole>('learner');
  const [keyInput, setKeyInput] = useState('');
  const [connectErr, setConnectErr] = useState<string | null>(null);
  const [walletErr, setWalletErr] = useState<string | null>(null);
  const [walletBusy, setWalletBusy] = useState(false);
  const [guestErr, setGuestErr] = useState<string | null>(null);
  const [guestBusy, setGuestBusy] = useState(false);
  // A guest this browser keeps (auth/durable-guest.ts): whether the deployment offers it, whether the
  // person asked for it, and the guest already kept here, if any. All three stay empty where the
  // deployment does not keep guests or the browser cannot, and the page is then what it always was.
  const [offer, setOffer] = useState<DurableGuestOffer | null>(null);
  const [keep, setKeep] = useState(false);
  const [kept, setKept] = useState<{ address: string; guestExpiresAt: string } | null>(null);
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const deps = browserGuestDeps();
        const [offered, existing] = await Promise.all([durableGuestOffer(BRIDGE_BASE, deps), keptGuest(deps)]);
        if (!live) return;
        setOffer(offered);
        // Keeping is the default only where nothing has to be agreed to first.
        setKeep(!!offered && !offered.terms);
        setKept(existing);
      } catch { /* no IndexedDB, or no WebCrypto: the tab-only guest */ }
    })();
    return () => { live = false; };
  }, []);
  const hasExtension = !!walletExtension();
  const learners = learnerSessionOptions();
  const admin = adminSessionOption();

  return (
    <div style={{ maxWidth: 720, margin: '60px auto', padding: 20 }}>
      <div style={{ textAlign: 'center', marginBottom: 30 }}>
        <div style={{ fontSize: 32, fontWeight: 700, color: 'var(--accent)' }}>Foxxi</div>
        <div style={{ color: 'var(--text-dim)', marginTop: 8, fontSize: 14 }}>
          Acme Training Co · Interego-grounded learning & development
        </div>
      </div>

      <Card title="Start now, with no account">
        <div style={{ color: 'var(--text-dim)', fontSize: 12, marginBottom: 10 }}>
          This tab makes a key of its own and signs in as it. You can play what is hosted here, bring a
          package of your own, and read your own record straight away. The key is your identity and stays
          in this tab; you will be shown a recovery phrase to come back as yourself.
        </div>
        <Button primary disabled={guestBusy} onClick={() => { void (async () => {
          setGuestBusy(true); setGuestErr(null);
          try {
            const guest = await connectAsGuest(SAMPLE_TENANT_POD_URL);
            let keptUntil: string | undefined;
            if (offer && keep && guest.guestRecoveryPhrase) {
              // Keeping is best effort: a guest the browser could not keep is still a guest, in this tab.
              try {
                keptUntil = (await keepGuest({ bridgeUrl: BRIDGE_BASE, offer, phrase: guest.guestRecoveryPhrase,
                  address: guest.userId, ...(offer.terms ? { acceptedTermsVersion: offer.terms.version } : {}) }, browserGuestDeps())).guestExpiresAt;
              } catch { keptUntil = undefined; }
            }
            onSignIn(keptUntil ? { ...guest, guestKeptUntil: keptUntil } : guest);
          }
          catch (e) { setGuestErr((e as Error).message); }
          finally { setGuestBusy(false); }
        })(); }}>{guestBusy ? 'Making your key…' : 'Start as a guest'}</Button>
        {offer && (
          <label data-testid="keep-guest" style={{ display: 'block', fontSize: 12, marginTop: 8 }}>
            <input type="checkbox" checked={keep} onChange={e => setKeep(e.target.checked)} />{' '}
            Keep this guest in this browser{offer.ttlSeconds ? ` for about ${Math.max(1, Math.round(offer.ttlSeconds / 3600))} hours` : ''}, so a reload
            does not lose it. Your recovery phrase is stored encrypted, with a key only this browser can use.
            {offer.terms && (
              <> By ticking this you agree to the <a href={offer.terms.url} target="_blank" rel="noreferrer">Terms</a>
                {offer.terms.privacyUrl && <> and the <a href={offer.terms.privacyUrl} target="_blank" rel="noreferrer">Privacy Notice</a></>} of
                the service that stores it.</>
            )}
          </label>
        )}
        {kept && (
          <div data-testid="kept-guest" style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
            <div style={{ fontSize: 12, marginBottom: 6 }}>
              This browser keeps a guest, <code>{kept.address.slice(0, 6)}…{kept.address.slice(-4)}</code>, until {new Date(kept.guestExpiresAt).toLocaleString()}.
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <Button disabled={guestBusy} onClick={() => { void (async () => {
                setGuestBusy(true); setGuestErr(null);
                try {
                  const opened = await openKeptGuest(browserGuestDeps());
                  const guest = await connectAsGuest(SAMPLE_TENANT_POD_URL, () => ethers.Wallet.fromPhrase(opened.phrase));
                  onSignIn({ ...guest, guestKeptUntil: kept.guestExpiresAt });
                } catch (e) {
                  setGuestErr(`That guest could not be opened (${(e as Error).message}).`);
                  setKept(await keptGuest(browserGuestDeps()).catch(() => null));
                } finally { setGuestBusy(false); }
              })(); }}>Continue as that guest</Button>
              <Button disabled={guestBusy} onClick={() => { void (async () => {
                await forgetKeptGuest(browserGuestDeps()).catch(() => undefined);
                setKept(null);
              })(); }}>Forget it on this browser</Button>
            </div>
          </div>
        )}
        {guestErr && <div style={{ color: 'var(--bad)', fontSize: 12, marginTop: 6 }}>✗ {guestErr}</div>}
        <div style={{ fontSize: 12, marginTop: 10 }}>
          <a href={`${BRIDGE_BASE}/start`} target="_blank" rel="noreferrer">What can I do here?</a>
        </div>
      </Card>

      <Card title="Choose an audience">
        <div style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
          <Button primary={role === 'learner'} onClick={() => setRole('learner')}>Learner</Button>
          <Button primary={role === 'admin'} onClick={() => setRole('admin')}>L&D administrator</Button>
        </div>

        {role === 'admin' ? (
          <div>
            <div style={{ color: 'var(--text-dim)', fontSize: 12, marginBottom: 10 }}>
              The admin view manages the tenant catalog + policies + coverage queries + audit log.
            </div>
            <Button primary onClick={() => { void (async () => onSignIn(await sessionFromOption(admin, 'admin', SAMPLE_TENANT_POD_URL)))(); }}>
              Sign in as {admin.name} ({admin.jobTitle})
            </Button>
          </div>
        ) : (
          <div>
            <div style={{ color: 'var(--text-dim)', fontSize: 12, marginBottom: 10 }}>
              Pick a learner from the Acme Training Co roster — different audience tags get different course assignments.
              Joshua Liu (engineering) is a good starting point for the Golf Explained demo.
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {learners.map(l => (
                <div key={l.webId} style={{
                  display: 'flex', alignItems: 'center', gap: 12,
                  padding: 10, background: 'var(--panel-2)', borderRadius: 6,
                  border: '1px solid var(--border)',
                }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 500 }}>{l.name}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>
                      {l.jobTitle} · {l.department}
                    </div>
                    <div style={{ marginTop: 4, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                      {l.audienceTags.map(t => <Pill key={t}>{t}</Pill>)}
                    </div>
                  </div>
                  <Button onClick={() => { void (async () => onSignIn(await sessionFromOption(l, 'learner', SAMPLE_TENANT_POD_URL)))(); }}>
                    Sign in
                  </Button>
                </div>
              ))}
            </div>

            <div style={{ color: 'var(--text-dim)', fontSize: 12, margin: '18px 0 10px' }}>
              Or sign in with <strong>a wallet extension</strong> in this browser. Your key stays in the wallet:
              it signs your session now. After that, where the bridge takes session keys, it asks you once an hour
              to let this tab sign for you with a key that never leaves the tab; otherwise it asks you to approve
              each signed request (every step you play, everything you author).
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <Button primary disabled={!hasExtension || walletBusy} onClick={() => { void (async () => {
                setWalletBusy(true); setWalletErr(null);
                try { onSignIn(await connectFromExtension(SAMPLE_TENANT_POD_URL)); }
                catch (e) { setWalletErr((e as Error).message); }
                finally { setWalletBusy(false); }
              })(); }}>{walletBusy ? 'Waiting for your wallet…' : 'Use my wallet extension'}</Button>
              {!hasExtension && <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>No wallet extension was found in this browser.</span>}
            </div>
            {walletErr && <div style={{ color: 'var(--bad)', fontSize: 12, marginTop: 6 }}>✗ {walletErr}</div>}

            <div style={{ color: 'var(--text-dim)', fontSize: 12, margin: '18px 0 10px' }}>
              Or <strong>connect a self-sovereign identity</strong> by its key — e.g. the maintainer
              wallet (<code>did:ethr</code>). The dashboard signs as that real identity, so
              <em> My forwarding</em> keys to its real lens. (johnny &amp; boozer are relay + OAuth-mediated
              and have no exportable key — they act only from their own session.)
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <input
                type="password"
                placeholder="private key (0x…64 hex) or 12/24-word phrase"
                value={keyInput}
                onChange={e => { setKeyInput(e.target.value); setConnectErr(null); }}
                style={{ flex: 1, minWidth: 280, padding: 8, borderRadius: 4, border: '1px solid var(--border)', background: 'var(--panel)', color: 'var(--text)', fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }}
              />
              <Button primary disabled={!keyInput.trim()} onClick={() => { void (async () => {
                try { onSignIn(await connectFromPrivateKey(keyInput, SAMPLE_TENANT_POD_URL)); }
                catch (e) { setConnectErr((e as Error).message); }
              })(); }}>Connect</Button>
            </div>
            {connectErr && <div style={{ color: 'var(--bad)', fontSize: 12, marginTop: 6 }}>✗ {connectErr}</div>}
            <div style={{ color: 'var(--text-dim)', fontSize: 10, marginTop: 6 }}>
              Your key is kept in memory for this tab only — never written to disk / localStorage;
              you'll re-connect after a reload. Use a dev/demo key.
            </div>
          </div>
        )}
      </Card>

      <div style={{ color: 'var(--text-dim)', fontSize: 11, textAlign: 'center', marginTop: 20 }}>
        Demo identity — production uses the substrate's real auth flow (DID-resolution, SIWE / WebAuthn, did:web / did:ethr).
        Selected identity becomes the <code>learner_did</code> argument on every Interego affordance call.
      </div>
    </div>
  );
}
