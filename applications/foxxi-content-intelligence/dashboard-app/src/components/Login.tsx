import React, { useState } from 'react';
import { Card, Button, Pill } from './common.js';
import {
  adminSessionOption, learnerSessionOptions, agentSessionOptions, sessionFromOption,
  type SessionRole, type FoxxiSession,
} from '../auth/session.js';
import { SAMPLE_TENANT_POD_URL } from '../sample/data.js';

export function Login({ onSignIn }: { onSignIn: (s: FoxxiSession) => void }) {
  const [role, setRole] = useState<SessionRole>('learner');
  const learners = learnerSessionOptions();
  const agents = agentSessionOptions();
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
              Self-sovereign agents (tenant-resident demo logins) — maintainer, johnny, boozer.
              They also act over the A2A mesh via signed affordances.
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {agents.map(a => (
                <div key={a.webId} style={{
                  display: 'flex', alignItems: 'center', gap: 12,
                  padding: 10, background: 'var(--panel-2)', borderRadius: 6,
                  border: '1px solid var(--border)',
                }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 500 }}>{a.name}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>{a.jobTitle} · {a.department}</div>
                    <div style={{ marginTop: 4, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                      {a.audienceTags.map(t => <Pill key={t}>{t}</Pill>)}
                    </div>
                  </div>
                  <Button onClick={() => { void (async () => onSignIn(await sessionFromOption(a, 'learner', SAMPLE_TENANT_POD_URL)))(); }}>
                    Sign in
                  </Button>
                </div>
              ))}
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
