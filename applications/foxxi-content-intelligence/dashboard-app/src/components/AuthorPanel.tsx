/**
 * Author: write fragments, compose them, fold a hosted SCORM package into them, and see what each
 * composition has learned. Everything here is an affordance an agent uses the same way
 * (foxxi.content_fragment, foxxi.content_compose, foxxi.content_fold_course, foxxi.content_mine,
 * and a composition's efficacy), signed as the author.
 *
 * The shelf is what the author made or picked up in this browser, to compose from. What they made
 * anywhere is in their record, read under "What you made".
 */
import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Card, Pill, TextInput } from './common.js';
import { FragmentEditor } from './FragmentEditor.js';
import { CompositionEditor } from './CompositionEditor.js';
import { FoldPackageCard } from './FoldPackageCard.js';
import { useAffordance, useHypermedia } from '../hypermedia.js';
import type { FoxxiSession } from '../auth/session.js';
import { signerAsks, signerFor } from '../auth/signer.js';
import { postSigned } from '../auth/signed-request.js';
import { bridgeBaseOf } from '../learn/bridge.js';
import { hashOfComposition } from '../learn/composition-ref.js';
import type { Mine } from '../learn/play.js';
import { contentKindOf } from '../author/compose.js';
import { readShelf, shelfKey, shelve, unshelve, type ShelfItem } from '../author/shelf.js';

type Tab = 'write' | 'compose' | 'fold' | 'shelf' | 'made';
const TABS: ReadonlyArray<{ tab: Tab; label: string }> = [
  { tab: 'write', label: 'Write a fragment' }, { tab: 'compose', label: 'Compose' }, { tab: 'fold', label: 'Fold a package' },
  { tab: 'shelf', label: 'Your shelf' }, { tab: 'made', label: 'What you made' },
];

export function AuthorPanel({ session }: { session: FoxxiSession }) {
  const [tab, setTab] = useState<Tab>('write');
  const [shelf, setShelf] = useState<ShelfItem[]>(() => { try { return readShelf(localStorage.getItem(shelfKey(session.webId))); } catch { return []; } });
  const keep = (next: ShelfItem[]) => {
    setShelf(next);
    try { localStorage.setItem(shelfKey(session.webId), JSON.stringify(next)); } catch { /* a browser that keeps nothing still composes */ }
  };
  const put = (item: ShelfItem) => keep(shelve(shelf, item));

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div role="tablist" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {TABS.map(t => (
          <Button key={t.tab} small primary={tab === t.tab} onClick={() => setTab(t.tab)}>
            {t.label}{t.tab === 'shelf' && shelf.length ? ` (${shelf.length})` : ''}
          </Button>
        ))}
      </div>
      {tab === 'write' && <FragmentEditor session={session} onAuthored={put} />}
      {tab === 'compose' && <CompositionEditor session={session} shelf={shelf} onComposed={put} />}
      {tab === 'fold' && <FoldPackageCard session={session} onFolded={put} />}
      {tab === 'shelf' && <ShelfCard shelf={shelf} onPut={put} onRemove={iri => keep(unshelve(shelf, iri))} />}
      {tab === 'made' && <MadeCard session={session} />}
      <div style={{ color: 'var(--text-dim)', fontSize: 12 }}>
        An agent authors the same way: <code>foxxi.content_fragment</code>, <code>foxxi.content_compose</code>, <code>foxxi.content_fold_course</code>, signed as itself.
      </div>
    </div>
  );
}

function ShelfCard({ shelf, onPut, onRemove }: { shelf: ShelfItem[]; onPut: (item: ShelfItem) => void; onRemove: (iri: string) => void }) {
  const navigate = useNavigate();
  const { entry } = useHypermedia();
  const base = bridgeBaseOf(entry);
  const [paste, setPaste] = useState('');
  const [why, setWhy] = useState<string | null>(null);

  /** Pick up a fragment or composition by its IRI: read here from its public form, so the shelf can name it. */
  async function pickUp(): Promise<void> {
    const iri = paste.trim();
    const type = contentKindOf(iri);
    if (!type) { setWhy('That is not a fragment\'s or a composition\'s IRI.'); return; }
    const hash = iri.slice(-64);
    try {
      const r = await fetch(`${base}/ns/foxxi/${type}/${hash}`, { headers: { Accept: 'application/json' } });
      if (r.status === 404) { setWhy('This bridge holds nothing with that hash, so it could not be composed from here.'); return; }
      // Any other refusal is not the content: say so, and shelve nothing.
      if (!r.ok) {
        const said = (await r.json().catch(() => ({})) as { error?: unknown }).error;
        setWhy(`It could not be read just now${typeof said === 'string' ? `: ${said}` : ` (HTTP ${r.status})`}. Nothing was put on your shelf.`);
        return;
      }
      const body = await r.json() as { title?: string; kind?: string; level?: string };
      onPut({ iri, type, at: new Date().toISOString(), ...(body.title ? { title: body.title } : {}), ...(body.kind ? { kind: body.kind } : {}), ...(body.level ? { level: body.level } : {}) });
      setPaste(''); setWhy(null);
    } catch (e) { setWhy((e as Error).message); }
  }

  return (
    <Card title="Your shelf">
      <div style={{ fontSize: 14, color: 'var(--text-dim)', marginBottom: 10 }}>What you made or picked up in this browser, to compose from.</div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <TextInput value={paste} onChange={v => { setPaste(v); setWhy(null); }} onSubmit={() => { void pickUp(); }} placeholder="Pick up a fragment or composition by its IRI" ariaLabel="A fragment's or composition's IRI" />
        <Button small disabled={!paste.trim()} onClick={() => { void pickUp(); }}>Pick up</Button>
      </div>
      {why && <div role="alert" style={{ color: 'var(--bad)', fontSize: 13, marginBottom: 8 }}>{why}</div>}
      {shelf.length === 0 && <div style={{ color: 'var(--text-dim)', fontSize: 14 }}>Nothing on it yet.</div>}
      {shelf.map(s => {
        const hash = s.type === 'composition' ? hashOfComposition(s.iri) : undefined;
        return (
          <div key={s.iri} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', padding: '6px 10px', border: '1px solid var(--border)', borderRadius: 4, background: 'var(--panel-2)', marginBottom: 6 }}>
            <Pill tone={s.type === 'composition' ? 'accent' : 'neutral'}>{s.type}</Pill>
            <strong>{s.title ?? 'Untitled'}</strong>
            {s.kind && <Pill>{s.kind}</Pill>}{s.level && <Pill>{s.level}</Pill>}
            <code style={{ fontSize: 11, color: 'var(--text-dim)', wordBreak: 'break-all', flex: 1 }}>{s.iri}</code>
            {hash && <a href={`/author/${hash}`} onClick={e => { e.preventDefault(); navigate(`/author/${hash}`); }}>What it has learned</a>}
            <Button small onClick={() => onRemove(s.iri)}>Take off</Button>
          </div>
        );
      })}
    </Card>
  );
}

function MadeCard({ session }: { session: FoxxiSession }) {
  const navigate = useNavigate();
  const mine = useAffordance('foxxi.content_mine');
  const asks = signerAsks(session);
  const [made, setMade] = useState<Mine['authored'] | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'failed'>('idle');
  const [error, setError] = useState('');

  async function load(href: string): Promise<void> {
    setState('loading');
    try { setMade((await postSigned<Mine>(href, signerFor(session), { limit: 100 })).authored ?? []); setState('idle'); }
    catch (e) { setError((e as Error).message); setState('failed'); }
  }
  const href = mine?.href;
  useEffect(() => { if (href && !asks) void load(href); }, [href, asks, session.webId]);

  return (
    <Card title="What you made" right={mine && state !== 'loading' ? <Button small onClick={() => { void load(mine.href); }}>{made ? 'Read again' : 'Read it'}</Button> : undefined}>
      {!mine && <div style={{ color: 'var(--text-dim)' }}>This bridge lists nothing (no foxxi.content_mine).</div>}
      {mine && !made && state === 'idle' && asks && <div style={{ color: 'var(--text-dim)', fontSize: 14 }}>Reading your record is signed as you: your wallet will ask you to approve it.</div>}
      {state === 'loading' && <div style={{ color: 'var(--text-dim)' }}>Reading your record…</div>}
      {state === 'failed' && <div role="alert" style={{ color: 'var(--bad)' }}>{error}</div>}
      {made && made.length === 0 && <div style={{ color: 'var(--text-dim)', fontSize: 14 }}>No compositions yet.</div>}
      {made?.map(a => {
        const hash = hashOfComposition(a.iri);
        if (!hash) return null;
        const go = (to: string) => (e: React.MouseEvent) => { e.preventDefault(); navigate(to); };
        return (
          <div key={a.iri} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', padding: '6px 10px', border: '1px solid var(--border)', borderRadius: 4, background: 'var(--panel-2)', marginBottom: 6 }}>
            <strong>{a.title ?? `Untitled composition ${hash.slice(0, 8)}…`}</strong>
            {a.root && <Pill>made as a whole</Pill>}
            <span style={{ flex: 1 }} />
            <a href={`/author/${hash}`} onClick={go(`/author/${hash}`)}>What it has learned</a>
            <a href={`/learn/${hash}`} onClick={go(`/learn/${hash}`)}>Play it</a>
          </div>
        );
      })}
    </Card>
  );
}
