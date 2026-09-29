/**
 * Fold a SCORM package hosted here, or an authoring tool's own export kept here to be folded, into
 * your own content: each page a concept fragment, the pages in one folder a topic, and the
 * questions the package declares a check graded here. Signed as you, kept on your pod, and put on
 * your shelf to compose from. An agent folds one the same way (foxxi.content_fold_course with
 * package_sha256).
 */
import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Card, Pill } from './common.js';
import { linkOf, useAffordance, useHypermedia } from '../hypermedia.js';
import type { FoxxiSession } from '../auth/session.js';
import { signerAsks, signerFor } from '../auth/signer.js';
import { postSigned } from '../auth/signed-request.js';
import { foldablePackagesFrom, type FoldablePackage } from '../learn/hosted-packages.js';
import { hashOfComposition } from '../learn/composition-ref.js';
import { foldedPackageFrom, type FoldedPackageView } from '../author/package-fold.js';
import type { ShelfItem } from '../author/shelf.js';

type Fold = { state: 'folding' } | { state: 'folded'; view: FoldedPackageView } | { state: 'failed'; error: string };

const row: React.CSSProperties = {
  display: 'grid', gap: 6, padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 4, background: 'var(--panel-2)', marginBottom: 6,
};

export function FoldPackageCard({ session, onFolded }: { session: FoxxiSession; onFolded: (item: ShelfItem) => void }) {
  const navigate = useNavigate();
  const { entry } = useHypermedia();
  const listHref = linkOf(entry, 'scorm-packages');
  const fold = useAffordance('foxxi.content_fold_course');
  const asks = signerAsks(session);
  const [packages, setPackages] = useState<FoldablePackage[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [folds, setFolds] = useState<Record<string, Fold>>({});

  useEffect(() => {
    if (!listHref) return;
    let cancel = false;
    fetch(listHref, { headers: { Accept: 'application/json' } })
      .then(r => { if (!r.ok) throw new Error(`the bridge answered ${r.status}`); return r.json() as Promise<unknown>; })
      .then(body => { if (!cancel) setPackages(foldablePackagesFrom(body)); })
      .catch((e: unknown) => { if (!cancel) setListError((e as Error).message); });
    return () => { cancel = true; };
  }, [listHref]);

  async function foldIt(p: FoldablePackage): Promise<void> {
    if (!fold) return;
    setFolds(f => ({ ...f, [p.packageSha256]: { state: 'folding' } }));
    try {
      const view = foldedPackageFrom(await postSigned(fold.href, signerFor(session), { package_sha256: p.packageSha256 }));
      if (!view) throw new Error('the fold answered with no composition');
      onFolded({ iri: view.iri, type: 'composition', title: view.title, at: new Date().toISOString() });
      setFolds(f => ({ ...f, [p.packageSha256]: { state: 'folded', view } }));
    } catch (e) {
      setFolds(f => ({ ...f, [p.packageSha256]: { state: 'failed', error: (e as Error).message } }));
    }
  }

  const go = (to: string) => (e: React.MouseEvent) => { e.preventDefault(); navigate(to); };
  return (
    <Card title="Fold a package into your content">
      <div style={{ color: 'var(--text-dim)', fontSize: 14, marginBottom: 10 }}>
        A SCORM package hosted here, or an authoring tool's own export kept here to be folded, taken apart: each page
        becomes a fragment, the pages in one folder a topic, and the questions the package declares a check graded here. What it makes is kept on your pod and put on your shelf, so you
        can offer another way in at any position and see what works{asks ? '; your wallet asks first' : ''}.
      </div>
      {!listHref && <div style={{ color: 'var(--text-dim)', fontSize: 14 }}>This bridge lists no hosted packages.</div>}
      {listError && <div role="alert" style={{ color: 'var(--bad)', fontSize: 13 }}>The packages could not be listed: {listError}</div>}
      {listHref && !packages && !listError && <div style={{ color: 'var(--text-dim)' }}>Listing the packages…</div>}
      {packages && packages.length === 0 && <div style={{ color: 'var(--text-dim)', fontSize: 14 }}>No packages are hosted here yet.</div>}
      {packages?.map(p => {
        const f = folds[p.packageSha256];
        const hash = f?.state === 'folded' ? hashOfComposition(f.view.iri) : undefined;
        return (
          <div key={p.packageSha256} style={row}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontSize: 16 }}>{p.title}</span>
              {p.exportOf && <Pill tone="neutral">{p.exportOf} export</Pill>}
              <span style={{ flex: 1 }} />
              {f?.state !== 'folded' && (
                <Button small primary disabled={!fold || f?.state === 'folding'} onClick={() => { void foldIt(p); }}>
                  {f?.state === 'folding' ? (asks ? 'Approve in your wallet…' : 'Folding…') : 'Fold it'}
                </Button>
              )}
            </div>
            {f?.state === 'failed' && <div role="alert" style={{ color: 'var(--bad)', fontSize: 13 }}>{f.error}</div>}
            {f?.state === 'folded' && (
              <div style={{ fontSize: 14, display: 'grid', gap: 6 }}>
                <div>
                  Folded into <strong>{f.view.title}</strong>: {f.view.items} fragments and compositions, on your shelf.
                  {hash && <> <a href={`/learn/${hash}`} onClick={go(`/learn/${hash}`)}>Play it</a> · <a href={`/author/${hash}`} onClick={go(`/author/${hash}`)}>What it has learned</a></>}
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {f.view.topics.map((t, i) => (
                    <Pill key={i} tone={t.folded ? 'neutral' : 'warn'}>{t.title}: {t.pages === 1 ? '1 page' : `${t.pages} pages`}{t.questions ? `, ${t.questions === 1 ? '1 question' : `${t.questions} questions`}` : ''}</Pill>
                  ))}
                </div>
                {f.view.checks && <div style={{ color: 'var(--text-dim)', fontSize: 12 }}>{f.view.checks}</div>}
                {f.view.unread.length > 0 && (
                  <details>
                    <summary style={{ cursor: 'pointer', fontSize: 13 }}>Not read: {f.view.unread.length === 1 ? '1 file' : `${f.view.unread.length} files`}, and why</summary>
                    <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 12 }}>
                      {f.view.unread.map((u, i) => <li key={i}><code>{u.path}</code>: {u.why}</li>)}
                    </ul>
                  </details>
                )}
              </div>
            )}
          </div>
        );
      })}
      {!fold && <div style={{ color: 'var(--text-dim)', fontSize: 12 }}>This bridge offers no fold (foxxi.content_fold_course).</div>}
    </Card>
  );
}
