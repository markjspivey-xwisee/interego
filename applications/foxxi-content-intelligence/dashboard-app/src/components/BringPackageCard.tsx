/**
 * Bring a SCORM or cmi5 package to this bridge, as whoever is signed in.
 *
 * Anyone who signs may bring one (foxxi.host_package_signed): a guest on a key this tab made as
 * much as a roster learner. The file is read here, signed as the session's identity, and sent; the
 * bridge parses it, keeps it by its sha-256 and lists it for anyone to play. Where the bridge does
 * not offer the affordance (an older bridge, or one that closed it) the card is not shown.
 */
import React, { useRef, useState } from 'react';
import { Button, Card } from './common.js';
import { useAffordance } from '../hypermedia.js';
import type { FoxxiSession } from '../auth/session.js';
import { signerAsks, signerFor } from '../auth/signer.js';
import { postSigned } from '../auth/signed-request.js';
import { base64OfBytes, broughtFrom, whyNotBring, type Brought } from '../learn/bring-package.js';

type State = { state: 'idle' } | { state: 'sending'; name: string } | { state: 'done'; brought: Brought } | { state: 'failed'; error: string };

export function BringPackageCard({ session, onHosted }: { session: FoxxiSession; onHosted: () => void }) {
  const host = useAffordance('foxxi.host_package_signed');
  const asks = signerAsks(session);
  const input = useRef<HTMLInputElement>(null);
  const [st, setSt] = useState<State>({ state: 'idle' });

  async function bring(file: File): Promise<void> {
    if (!host) return;
    const no = whyNotBring(file);
    if (no) { setSt({ state: 'failed', error: no }); return; }
    setSt({ state: 'sending', name: file.name });
    try {
      const zip_base64 = base64OfBytes(new Uint8Array(await file.arrayBuffer()));
      const brought = broughtFrom(await postSigned(host.href, signerFor(session), { zip_base64, hinted_title: file.name.replace(/\.zip$/i, '') }));
      setSt({ state: 'done', brought });
      if (brought.hosted) onHosted();
    } catch (e) {
      setSt({ state: 'failed', error: (e as Error).message });
    } finally {
      if (input.current) input.current.value = '';
    }
  }

  if (!host) return null;
  return (
    <Card title="Bring a package">
      <div style={{ color: 'var(--text-dim)', fontSize: 14, marginBottom: 10 }}>
        Bring a SCORM or cmi5 <code>.zip</code>, or an authoring tool's own export. It is signed as you
        {asks ? ' (your wallet asks first)' : ''}, kept on this bridge and listed below for anyone to play.
        It is public once brought, so bring only what you may share.
      </div>
      <input ref={input} type="file" accept=".zip,.h5p,application/zip" aria-label="Package to bring" disabled={st.state === 'sending'}
        onChange={e => { const f = e.target.files?.[0]; if (f) void bring(f); }} style={{ display: 'none' }} />
      <Button primary disabled={st.state === 'sending'} onClick={() => input.current?.click()}>
        {st.state === 'sending' ? (asks ? 'Approve in your wallet…' : `Bringing ${st.name}…`) : 'Choose a package'}
      </Button>
      {st.state === 'failed' && <div role="alert" style={{ color: 'var(--bad)', fontSize: 13, marginTop: 8 }}>{st.error}</div>}
      {st.state === 'done' && st.brought.hosted && st.brought.playable && (
        <div role="status" style={{ fontSize: 14, marginTop: 8 }}>
          <strong>{st.brought.title}</strong> is hosted here. Launch it from the list below.
        </div>
      )}
      {st.state === 'done' && st.brought.hosted && !st.brought.playable && (
        <div role="status" style={{ fontSize: 14, marginTop: 8 }}>
          <strong>{st.brought.title}</strong> is kept here. {st.brought.why}
        </div>
      )}
      {st.state === 'done' && !st.brought.hosted && <div role="alert" style={{ color: 'var(--bad)', fontSize: 13, marginTop: 8 }}>{st.brought.why}</div>}
    </Card>
  );
}
