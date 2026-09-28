/**
 * Learn: where a learner finds a composition to play.
 *
 * Three ways in: a link, IRI or hash someone handed them; the ones they opened lately in this
 * browser; and the ones their own record says they played or made, read with foxxi.content_mine.
 * Below them, the SCORM packages this bridge hosts, each launched as a cmi5 course.
 * The first two need no signature. The third is signed as the learner, so with a wallet extension
 * it waits for them to ask, as every prompt should.
 */
import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Card, Pill, TextInput } from './common.js';
import { useAffordance, useHypermedia } from '../hypermedia.js';
import type { FoxxiSession } from '../auth/session.js';
import { signerAsks, signerFor } from '../auth/signer.js';
import { postSigned } from '../auth/signed-request.js';
import { compositionRefFrom, hashOfComposition } from '../learn/composition-ref.js';
import { readRecents, recentsKey, type RecentComposition } from '../learn/recents.js';
import type { AuthoredComposition, Mine, PlayedComposition } from '../learn/play.js';
import { HostedPackagesCard } from './HostedPackagesCard.js';

const row: React.CSSProperties = {
  display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', padding: '8px 10px',
  border: '1px solid var(--border)', borderRadius: 4, background: 'var(--panel-2)', marginBottom: 6,
};
const when = (at: string | undefined): string => {
  if (!at) return '';
  const t = Date.parse(at);
  return Number.isFinite(t) ? new Date(t).toLocaleString() : '';
};
const nameOf = (c: { title?: string }, hash: string): string => c.title ?? `Untitled composition ${hash.slice(0, 8)}…`;

type Listing =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'loaded'; authored: AuthoredComposition[]; played: PlayedComposition[] }
  | { state: 'failed'; error: string };

export function LearnPanel({ session }: { session: FoxxiSession }) {
  const navigate = useNavigate();
  const { entry, error: entryError } = useHypermedia();
  const mine = useAffordance('foxxi.content_mine');
  const asks = signerAsks(session);
  const [paste, setPaste] = useState('');
  const [pasteWhy, setPasteWhy] = useState<string | null>(null);
  const [recents, setRecents] = useState<RecentComposition[]>(() => {
    try { return readRecents(localStorage.getItem(recentsKey(session.webId))); } catch { return []; }
  });
  const [listing, setListing] = useState<Listing>({ state: 'idle' });

  async function load(href: string): Promise<void> {
    setListing({ state: 'loading' });
    try {
      const r = await postSigned<Mine>(href, signerFor(session), { limit: 50 });
      setListing({ state: 'loaded', authored: r.authored ?? [], played: r.played ?? [] });
    } catch (e) { setListing({ state: 'failed', error: (e as Error).message }); }
  }

  // Read without asking only when reading costs the learner nothing: a signer that prompts waits for a click.
  const href = mine?.href;
  useEffect(() => {
    if (href && !asks) void load(href);
  }, [href, asks, session.webId]);

  function open(): void {
    const ref = compositionRefFrom(paste);
    if ('why' in ref) { setPasteWhy(ref.why); return; }
    navigate(`/learn/${ref.hash}`);
  }
  const go = (hash: string) => (e: React.MouseEvent) => { e.preventDefault(); navigate(`/learn/${hash}`); };

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <Card title="Open a composition">
        <div style={{ color: 'var(--text-dim)', fontSize: 14, marginBottom: 10 }}>
          Paste a composition's link or IRI (from any bridge), or its hash. What you are shown is resolved for you from your own record.
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <TextInput value={paste} onChange={v => { setPaste(v); setPasteWhy(null); }} onSubmit={open}
            placeholder="https://…/ns/foxxi/composition/…" ariaLabel="A composition's link, IRI or hash" />
          <Button primary disabled={!paste.trim()} onClick={open}>Open</Button>
        </div>
        {pasteWhy && <div role="alert" style={{ color: 'var(--bad)', fontSize: 13, marginTop: 8 }}>{pasteWhy}</div>}
      </Card>

      <Card title="Opened lately" right={recents.length ? <Button small onClick={() => {
        try { localStorage.removeItem(recentsKey(session.webId)); } catch { /* nothing kept to clear */ }
        setRecents([]);
      }}>Clear</Button> : undefined}>
        {recents.length === 0
          ? <div style={{ color: 'var(--text-dim)', fontSize: 14 }}>Nothing opened in this browser yet.</div>
          : recents.map(r => (
            <div key={r.hash} style={row}>
              <a href={`/learn/${r.hash}`} onClick={go(r.hash)} style={{ fontSize: 16 }}>{nameOf(r, r.hash)}</a>
              <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>{when(r.at)}</span>
            </div>
          ))}
      </Card>

      <Card title="From your record" right={mine && listing.state !== 'loading'
        ? <Button small onClick={() => { void load(mine.href); }}>{listing.state === 'idle' ? 'Read it' : 'Read again'}</Button> : undefined}>
        {entryError && <div style={{ color: 'var(--bad)' }}>The bridge could not be reached: {entryError}</div>}
        {!entry && !entryError && <div style={{ color: 'var(--text-dim)' }}>Connecting to the bridge…</div>}
        {entry && !mine && <div style={{ color: 'var(--text-dim)' }}>This bridge does not list compositions yet (no foxxi.content_mine).</div>}
        {listing.state === 'idle' && mine && asks && (
          <div style={{ color: 'var(--text-dim)', fontSize: 14 }}>Reading your record is signed as you: your wallet will ask you to approve it.</div>
        )}
        {listing.state === 'loading' && <div style={{ color: 'var(--text-dim)' }}>{asks ? 'Approve the request in your wallet…' : 'Reading your record…'}</div>}
        {listing.state === 'failed' && <div role="alert" style={{ color: 'var(--bad)' }}>{listing.error}</div>}
        {listing.state === 'loaded' && (
          <div style={{ display: 'grid', gap: 12 }}>
            <div>
              <div className="label" style={{ marginBottom: 6 }}>Played</div>
              {listing.played.length === 0 && <div style={{ color: 'var(--text-dim)', fontSize: 14 }}>Nothing played yet.</div>}
              {listing.played.map(p => {
                const hash = hashOfComposition(p.iri);
                if (!hash) return null;
                return (
                  <div key={p.iri} style={row}>
                    <a href={`/learn/${hash}`} onClick={go(hash)} style={{ fontSize: 16 }}>{nameOf(p, hash)}</a>
                    {p.finished ? <Pill tone="good">finished</Pill> : <Pill>started</Pill>}
                    {p.score && <span style={{ fontSize: 13 }}>{p.score.raw} of {p.score.max} right, last time</span>}
                    <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>{when(p.at)}</span>
                  </div>
                );
              })}
            </div>
            <div>
              <div className="label" style={{ marginBottom: 6 }}>Made</div>
              {listing.authored.length === 0 && <div style={{ color: 'var(--text-dim)', fontSize: 14 }}>Nothing made yet.</div>}
              {listing.authored.map(a => {
                const hash = hashOfComposition(a.iri);
                if (!hash) return null;
                return (
                  <div key={a.iri} style={row}>
                    <a href={`/learn/${hash}`} onClick={go(hash)} style={{ fontSize: 16 }}>{nameOf(a, hash)}</a>
                    {a.root && <Pill title="Made as a whole, not only held inside another composition.">made as a whole</Pill>}
                    <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>{when(a.at)}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </Card>

      <HostedPackagesCard session={session} />

      <div style={{ color: 'var(--text-dim)', fontSize: 12 }}>
        An agent finds the same list with <code>foxxi.content_mine</code>, signed as itself, and the hosted packages at the entry point's <code>scorm-packages</code> link.
      </div>
    </div>
  );
}
