import React, { useState } from 'react';
import { Card, Button } from './common.js';
import type { FoxxiSession } from '../auth/session.js';

/**
 * What a guest must know before they close the tab: the key this tab made is their identity, it is
 * kept nowhere else, and its recovery phrase is the only way back to their own record. The phrase
 * is shown only when asked for, and copied only when asked. Nothing is rendered for a session that
 * is not a guest's.
 */
export function GuestKeyNotice({ session }: { session: FoxxiSession }) {
  const [shown, setShown] = useState(false);
  const [copied, setCopied] = useState<'no' | 'yes' | 'failed'>('no');
  const phrase = session.guestRecoveryPhrase;
  if (!phrase) return null;
  return (
    <Card title="You are a guest">
      <div style={{ fontSize: 13, marginBottom: 8 }}>
        You are signed in as <code>{session.webId}</code>, a key this tab made. What you play and bring is recorded as yours.
      </div>
      <div style={{ color: 'var(--text-dim)', fontSize: 12, marginBottom: 10 }}>
        The key is kept in this tab only. Close or reload it and the key is gone. To come back as yourself, write down
        your recovery phrase and paste it into <em>connect a self-sovereign identity</em> on the sign-in page. Anyone
        who has the phrase is you, so keep it to yourself.
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <Button onClick={() => { setShown(v => !v); setCopied('no'); }}>{shown ? 'Hide my recovery phrase' : 'Show my recovery phrase'}</Button>
        {shown && (
          <Button onClick={() => { void (async () => {
            try { await navigator.clipboard.writeText(phrase); setCopied('yes'); }
            catch { setCopied('failed'); }
          })(); }}>Copy it</Button>
        )}
        {copied === 'yes' && <span role="status" style={{ color: 'var(--text-dim)', fontSize: 12 }}>Copied.</span>}
        {copied === 'failed' && <span role="status" style={{ color: 'var(--bad)', fontSize: 12 }}>This browser would not copy it. Select it and copy it yourself.</span>}
      </div>
      {shown && (
        <div data-testid="guest-recovery-phrase" style={{ marginTop: 10, padding: 10, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--panel-2)', fontFamily: "'JetBrains Mono', monospace", fontSize: 13, wordSpacing: 4, userSelect: 'all' }}>
          {phrase}
        </div>
      )}
    </Card>
  );
}
