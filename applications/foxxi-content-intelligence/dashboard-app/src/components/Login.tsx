import React, { useState } from 'react';
import { Card, Button, Pill } from './common.js';
import {
  adminSessionOption, learnerSessionOptions, connectFromPrivateKey, sessionFromOption,
  type SessionRole, type FoxxiSession,
} from '../auth/session.js';
import { SAMPLE_TENANT_POD_URL } from '../sample/data.js';

export function Login({ onSignIn }: { onSignIn: (s: FoxxiSession) => void }) {
  const [role, setRole] = useState<SessionRole>('learner');
  const [keyInput, setKeyInput] = useState('');
  const [connectErr, setConnectErr] = useState<string | null>(null);
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
